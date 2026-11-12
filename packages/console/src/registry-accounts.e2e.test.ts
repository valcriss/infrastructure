import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { TRAEFIK_IMAGE, REGISTRY_IMAGE, generateRegistry } from "@infra/shared";
import bcrypt from "bcryptjs";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Comptes séparés du registre sur un vrai Traefik et un vrai registre : le compte de lecture lit mais ne peut rien
 * écrire (refusé par Traefik), le compte de publication écrit. Les labels sont ceux que génère la console (seul le
 * TLS est retiré : le test écoute en HTTP). Désactivé par défaut :
 *   PATCH_E2E=1 npx vitest run packages/console/src/registry-accounts.e2e.test.ts
 * \`PATCH_E2E_TRAEFIK_PORT\` : port local de Traefik (15080 par défaut).
 */
const enabled = process.env.PATCH_E2E === "1";
const PORT = Number(process.env.PATCH_E2E_TRAEFIK_PORT ?? 15080);
const HOST = "registry.exemple.fr";
const id = randomUUID().slice(0, 8);
const NET = `e2e-accounts-${id}`;
const VOLUME = `e2e-accounts-auth-${id}`;
const REGISTRY = `e2e-accounts-registry-${id}`;
const TRAEFIK = `e2e-accounts-traefik-${id}`;

const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quiet = (args: string[]): void => {
  try {
    docker(args);
  } catch {
    /* déjà supprimé */
  }
};

/** Statut HTTP d'une requête vers Traefik, avec le nom de domaine du registre (rien à résoudre côté DNS). */
const status = (method: string, path: string, user?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST };
    if (user) headers.authorization = `Basic ${Buffer.from(user).toString("base64")}`;
    const req = request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });

describe.skipIf(!enabled)("comptes séparés du registre (Traefik et registre réels)", () => {
  const PUBLISH = "mot-de-passe-publication";
  const PULL = "mot-de-passe-lecture";
  const MANIFEST = `/v2/console-probe/manifests/sha256:${"0".repeat(64)}`;

  beforeAll(async () => {
    const hash = (p: string, user: string): string => `${user}:${bcrypt.hashSync(p, 10).replace(/^\$2b\$/, "$2a$")}`;
    const generated = generateRegistry(
      { host: HOST, traefik: { entryPoint: "web", certResolver: "letsencrypt", network: NET } },
      { publish: hash(PUBLISH, "infrastructure"), pull: hash(PULL, "infrastructure-pull") },
    );
    const service = (parse(generated.compose) as { services: { registry: { labels: Record<string, string> } } }).services.registry;
    // Compose remplace « $$ » par « $ » ; le test écoute en HTTP : pas de TLS ni de résolveur de certificats.
    const labels = Object.entries(service.labels)
      .filter(([k]) => !/\.tls(\.|$)/.test(k))
      .flatMap(([k, v]) => ["--label", `${k}=${v.replaceAll("$$", "$")}`]);

    docker(["network", "create", NET]);
    docker(["volume", "create", VOLUME]);
    docker(["pull", "--quiet", "alpine:3.22.0"]);
    docker(["run", "--rm", "-v", `${VOLUME}:/auth`, "alpine:3.22.0", "sh", "-c", `printf '%s' '${generated.files["auth/htpasswd"] as string}' > /auth/htpasswd`]);
    docker([
      "run", "-d", "--name", REGISTRY, "--network", NET,
      "-e", "REGISTRY_STORAGE_DELETE_ENABLED=true", "-e", "REGISTRY_AUTH=htpasswd", "-e", "REGISTRY_AUTH_HTPASSWD_REALM=Registry", "-e", "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
      "-v", `${VOLUME}:/auth:ro`, ...labels, REGISTRY_IMAGE,
    ]);
    docker([
      "run", "-d", "--name", TRAEFIK, "--network", NET, "-p", `127.0.0.1:${PORT}:80`, "-v", "/var/run/docker.sock:/var/run/docker.sock:ro",
      TRAEFIK_IMAGE, "--providers.docker=true", "--providers.docker.exposedbydefault=false", "--entrypoints.web.address=:80",
    ]);
    // Traefik lit les conteneurs au démarrage : attendre que le routeur réponde.
    for (let i = 0; i < 30 && (await status("GET", "/v2/").catch(() => 0)) !== 401; i++) await new Promise((r) => setTimeout(r, 1000));
  }, 600_000);
  afterAll(() => {
    quiet(["rm", "-f", TRAEFIK, REGISTRY]);
    quiet(["volume", "rm", "-f", VOLUME]);
    quiet(["network", "rm", NET]);
  });

  it("refuse l'accès sans identifiants", async () => {
    expect(await status("GET", "/v2/")).toBe(401);
    expect(await status("DELETE", MANIFEST)).toBe(401);
  });

  it("le compte de lecture lit, mais Traefik lui refuse toute écriture", async () => {
    const pull = `infrastructure-pull:${PULL}`;
    expect(await status("GET", "/v2/", pull)).toBe(200);
    expect(await status("HEAD", MANIFEST, pull)).toBe(404); // lecture autorisée : le manifeste n'existe pas
    for (const method of ["DELETE", "PUT", "POST", "PATCH", "OPTIONS"]) expect(await status(method, "/v2/console-probe/blobs/uploads/", pull)).toBe(401);
    expect(await status("DELETE", MANIFEST, pull)).toBe(401);
  });

  it("le compte de publication lit et écrit", async () => {
    const publish = `infrastructure:${PUBLISH}`;
    expect(await status("GET", "/v2/", publish)).toBe(200);
    // Suppression d'un manifeste inexistant : l'écriture passe (404), rien n'est modifié.
    expect(await status("DELETE", MANIFEST, publish)).toBe(404);
    expect(await status("POST", "/v2/console-probe/blobs/uploads/", publish)).toBe(202);
  });

  it("refuse un mauvais mot de passe, y compris en écriture", async () => {
    expect(await status("GET", "/v2/", "infrastructure:mauvais")).toBe(401);
    expect(await status("DELETE", MANIFEST, "infrastructure:mauvais")).toBe(401);
    expect(await status("DELETE", MANIFEST, `infrastructure-pull:${PUBLISH}`)).toBe(401);
  });
});
