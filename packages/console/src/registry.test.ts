import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageRef } from "./image-ref.js";
import { RegistryClient, RegistryError, parseChallenge, realmAllowed, type RegistryCredentials } from "./registry.js";

const sha = (c: string) => "sha256:" + c.repeat(64);
const INDEX = sha("1");
const AMD64 = sha("2");
const ARM64 = sha("3");
const CFG_AMD64 = sha("a");
const CFG_ARM64 = sha("b");

interface FakeOptions {
  auth?: "none" | "bearer" | "basic";
  /** realm renvoyé dans le défi Bearer (par défaut : le serveur lui-même). */
  realm?: string;
  status?: number;
  tags?: string[];
}

interface Fake {
  server: Server;
  host: string;
  hits: { path: string; authorization: string | undefined }[];
  tokenHits: number;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function fake(opts: FakeOptions = {}): Promise<Fake> {
  const state: Fake = { server: null as unknown as Server, host: "", hits: [], tokenHits: 0 };
  const json = (res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    state.hits.push({ path: url.pathname + url.search, authorization: req.headers.authorization });

    if (url.pathname === "/token") {
      state.tokenHits++;
      const ok = req.headers.authorization === "Basic " + Buffer.from("alice:secret").toString("base64");
      return ok ? json(res, 200, { token: "T-OK", expires_in: 300 }) : json(res, 401, { errors: [] });
    }
    if (opts.status) return json(res, opts.status, {}, opts.status === 429 ? { "retry-after": "42" } : {});

    const authOk =
      opts.auth === "bearer" ? req.headers.authorization === "Bearer T-OK" : opts.auth === "basic" ? req.headers.authorization === "Basic " + Buffer.from("alice:secret").toString("base64") : true;
    if (!authOk) {
      const challenge = opts.auth === "bearer" ? `Bearer realm="${opts.realm ?? `http://${state.host}/token`}",service="fake"` : 'Basic realm="registre"';
      return json(res, 401, {}, { "www-authenticate": challenge });
    }
    if (url.pathname === "/v2/") return json(res, 200, {});
    if (url.pathname === "/v2/team/app/manifests/1.0" || url.pathname === `/v2/team/app/manifests/${INDEX}`) {
      const body = {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          { digest: AMD64, platform: { os: "linux", architecture: "amd64" } },
          { digest: ARM64, platform: { os: "linux", architecture: "arm64", variant: "v8" } },
        ],
      };
      return json(res, 200, body, { "docker-content-digest": INDEX, "content-type": "application/vnd.oci.image.index.v1+json" });
    }
    const leaf = url.pathname === `/v2/team/app/manifests/${AMD64}` ? [AMD64, CFG_AMD64] : url.pathname === `/v2/team/app/manifests/${ARM64}` ? [ARM64, CFG_ARM64] : null;
    if (leaf) return json(res, 200, { schemaVersion: 2, config: { digest: leaf[1] } }, { "docker-content-digest": leaf[0] as string, "content-type": "application/vnd.oci.image.manifest.v1+json" });
    if (url.pathname === `/v2/team/app/blobs/${CFG_AMD64}`) return json(res, 200, { rootfs: { type: "layers", diff_ids: [sha("7"), sha("8")] } });
    if (url.pathname === "/v2/team/app/blobs/" + sha("0")) return json(res, 200, { architecture: "amd64" }); // configuration sans couches
    if (url.pathname === "/v2/team/app/tags/list") {
      const all = opts.tags ?? ["1.0", "1.1", "1.2", "2.0", "latest"];
      const last = url.searchParams.get("last");
      const start = last ? all.indexOf(last) + 1 : 0;
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      return json(res, 200, { name: "team/app", tags: page }, more ? { link: `</v2/team/app/tags/list?n=2&last=${page[page.length - 1]}>; rel="next"` } : {});
    }
    return json(res, 404, { errors: [{ code: "NAME_UNKNOWN" }] });
  };
  state.server = createServer(handler);
  await new Promise<void>((r) => state.server.listen(0, "127.0.0.1", () => r()));
  servers.push(state.server);
  state.host = `127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  return state;
}

const refFor = (f: Fake, repository = "team/app"): ImageRef => ({ registry: f.host, apiHost: f.host, repository, tag: "1.0", digest: null, dockerHub: false });
const client = (creds: RegistryCredentials | null) => new RegistryClient({ credentials: async () => creds, minGapMs: 0 });
const INSECURE: RegistryCredentials = { username: null, password: null, insecure: true };
const ALICE: RegistryCredentials = { username: "alice", password: "secret", insecure: true };

describe("RegistryClient — registre public", () => {
  it("lit le digest d'un tag sans télécharger le manifeste (HEAD)", async () => {
    const f = await fake();
    const head = await client(INSECURE).headManifest(refFor(f), "1.0");
    expect(head).toEqual({ digest: INDEX, mediaType: "application/vnd.oci.image.index.v1+json" });
    expect(f.hits.every((h) => h.authorization === undefined)).toBe(true);
  });

  it("résout le manifeste et la configuration pour la plateforme demandée (multi-architecture)", async () => {
    const f = await fake();
    const c = client(INSECURE);
    expect(await c.resolvePlatform(refFor(f), "1.0", { os: "linux", arch: "amd64" })).toEqual({ manifestDigest: AMD64, configDigest: CFG_AMD64, indexDigest: INDEX });
    expect(await c.resolvePlatform(refFor(f), "1.0", { os: "linux", arch: "arm64", variant: "v8" })).toMatchObject({ manifestDigest: ARM64, configDigest: CFG_ARM64 });
    await expect(c.resolvePlatform(refFor(f), "1.0", { os: "linux", arch: "s390x" })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("lit les couches (diff_ids) d'une configuration pour comparer le contenu", async () => {
    const f = await fake();
    expect(await client(INSECURE).configLayers(refFor(f), CFG_AMD64)).toEqual([sha("7"), sha("8")]);
    await expect(client(INSECURE).configLayers(refFor(f), sha("0"))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("suit la pagination des tags", async () => {
    const f = await fake();
    expect(await client(INSECURE).listTags(refFor(f))).toEqual({ tags: ["1.0", "1.1", "1.2", "2.0", "latest"], truncated: false });
  });

  it("refuse HTTP sans option explicite et signale un registre injoignable", async () => {
    const f = await fake();
    const err = await client({ username: null, password: null, insecure: false }).headManifest(refFor(f), "1.0").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).code).toBe("network");
    // Un registre HTTP en clair contacté en HTTPS n'est pas un problème de certificat : le message guide vers l'option dédiée.
    expect((err as RegistryError).message).toContain("HTTP non sécurisé");
  });
});

describe("RegistryClient — registre privé", () => {
  it("Bearer : demande des identifiants, refuse les mauvais, accepte les bons et met le jeton en cache", async () => {
    const f = await fake({ auth: "bearer" });
    await expect(client(INSECURE).headManifest(refFor(f), "1.0")).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("identifiants sont nécessaires") });
    await expect(client({ ...ALICE, password: "faux" }).headManifest(refFor(f), "1.0")).rejects.toMatchObject({ code: "auth", message: expect.stringContaining("refusés") });

    const c = client(ALICE);
    f.tokenHits = 0;
    expect((await c.headManifest(refFor(f), "1.0")).digest).toBe(INDEX);
    await c.listTags(refFor(f));
    await c.resolvePlatform(refFor(f), "1.0", { os: "linux", arch: "amd64" });
    expect(f.tokenHits).toBe(1); // un seul jeton pour tous les appels
  });

  it("Basic : envoie les identifiants uniquement après le défi", async () => {
    const f = await fake({ auth: "basic" });
    expect((await client(ALICE).headManifest(refFor(f), "1.0")).digest).toBe(INDEX);
    expect(f.hits[0]?.authorization).toBeUndefined(); // première requête anonyme
    expect(f.hits[1]?.authorization).toMatch(/^Basic /);
    await expect(client(INSECURE).headManifest(refFor(f), "1.0")).rejects.toMatchObject({ code: "auth" });
  });

  it("n'envoie jamais les identifiants à un service d'authentification étranger", async () => {
    const evil = await fake();
    // Même adresse IP mais nom d'hôte différent (localhost) : hors du domaine du registre.
    const f = await fake({ auth: "bearer", realm: `http://localhost:${evil.host.split(":")[1]}/token` });
    await expect(client(ALICE).headManifest(refFor(f), "1.0")).rejects.toBeInstanceOf(RegistryError);
    expect(evil.hits.some((h) => h.authorization !== undefined)).toBe(false);
  });

  it("refuse un service d'authentification en HTTP sans option explicite", async () => {
    const f = await fake({ auth: "bearer" });
    const secure: RegistryCredentials = { ...ALICE, insecure: false };
    // HTTPS est tenté vers le registre : échec réseau, sans fuite des identifiants.
    await expect(client(secure).headManifest(refFor(f), "1.0")).rejects.toMatchObject({ code: "network" });
  });

  it("testAccess vérifie les identifiants enregistrés", async () => {
    const f = await fake({ auth: "bearer" });
    await expect(client(ALICE).testAccess(f.host)).resolves.toBeUndefined();
    await expect(client({ ...ALICE, password: "x" }).testAccess(f.host)).rejects.toMatchObject({ code: "auth" });
  });
});

describe("RegistryClient — erreurs", () => {
  it("classe 404, 429 (avec délai) et 5xx", async () => {
    const f = await fake();
    await expect(client(INSECURE).headManifest(refFor(f, "autre/depot"), "1.0")).rejects.toMatchObject({ code: "not_found" });
    const limited = await fake({ status: 429 });
    await expect(client(INSECURE).headManifest(refFor(limited), "1.0")).rejects.toMatchObject({ code: "rate_limited", retryAfterSec: 42 });
    const down = await fake({ status: 503 });
    await expect(client(INSECURE).headManifest(refFor(down), "1.0")).rejects.toMatchObject({ code: "network" });
  });
});

describe("realmAllowed et parseChallenge", () => {
  it("n'accepte que le même hôte, un sous-domaine du même domaine ou un service connu", () => {
    expect(realmAllowed("registry.example.org", "registry.example.org")).toBe(true);
    expect(realmAllowed("registry.example.org:5000", "registry.example.org:5001")).toBe(true);
    expect(realmAllowed("registry.corp.example.org", "auth.corp.example.org")).toBe(true);
    expect(realmAllowed("registry-1.docker.io", "auth.docker.io")).toBe(true);
    expect(realmAllowed("registry.gitlab.com", "gitlab.com")).toBe(true);
    expect(realmAllowed("registry.example.org", "evil.com")).toBe(false);
    expect(realmAllowed("registry.example.org", "registry.example.org.evil.com")).toBe(false);
    expect(realmAllowed("registry-1.docker.io", "evil.docker.io.attacker.net")).toBe(false);
  });
  it("lit les défis d'authentification", () => {
    expect(parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"')).toEqual({
      scheme: "bearer",
      params: { realm: "https://auth.docker.io/token", service: "registry.docker.io", scope: "repository:library/nginx:pull" },
    });
    expect(parseChallenge('Basic realm="x"')?.scheme).toBe("basic");
    expect(parseChallenge(null)).toBeNull();
  });
});
