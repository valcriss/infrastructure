import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { requiredRole } from "./permissions.js";
import { RegistryError } from "./registry.js";
import { RegistryImages, mentions } from "./registry-images.js";
import { RemediationApply } from "./remediation-apply.js";
import { changeStack, createStack } from "./stacks.js";

const url = process.env.TEST_DATABASE_URL;
const HOST = "registry.exemple.invalid";
const sha = (c: string): string => `sha256:${c.repeat(64)}`;
const REPO = "patched/docker-io-library-alpine";
const D_SRC = sha("0");
const D_P1 = sha("1");
const D_P2 = sha("2");
const D_OTHER = sha("9");

describe("références dans un texte", () => {
  it("ne confond pas -patch.1 avec -patch.10 ni un autre nom de domaine", () => {
    expect(mentions(`image: ${HOST}/${REPO}:3.22-patch.1\n`, `${HOST}/${REPO}:3.22-patch.1`)).toBe(true);
    expect(mentions(`image: ${HOST}/${REPO}:3.22-patch.10\n`, `${HOST}/${REPO}:3.22-patch.1`)).toBe(false);
    expect(mentions(`image: autre.${HOST}/${REPO}:3.22-patch.1\n`, `${HOST}/${REPO}:3.22-patch.1`)).toBe(false);
    expect(mentions(`image: "${HOST}/${REPO}@${D_P1}"`, `${HOST}/${REPO}@${D_P1}`)).toBe(true);
  });
});

describe("permissions", () => {
  it("lecture pour tout utilisateur, suppression réservée aux administrateurs", () => {
    expect(requiredRole("GET", "/api/v1/settings/registry/images")).toBe("viewer");
    expect(requiredRole("POST", "/api/v1/settings/registry/images/delete")).toBe("admin");
  });
});

describe.skipIf(!url)("images du registre (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let agent: WebSocket;
  let hostId = "";
  let stackId = "";
  let images: RegistryImages;
  const deleted: string[] = [];
  let failDelete: "405" | null = null;

  // Faux registre : dépôts → tag → digest.
  const repos: Record<string, Record<string, string>> = {
    [REPO]: { "3.22-patch.1": D_P1, "3.22-patch.2": D_P2, "src-abcdef": D_SRC },
    "autre/chose": { latest: D_OTHER },
  };
  const fake = {
    catalog: async () => ({ repositories: Object.keys(repos), truncated: false }),
    listTags: async (ref: { repository: string }) => ({ tags: Object.keys(repos[ref.repository] ?? {}), truncated: false }),
    headManifest: async (ref: { repository: string }, tag: string) => {
      const d = repos[ref.repository]?.[tag];
      if (!d) throw new RegistryError("not_found", "introuvable");
      return { digest: d, mediaType: "application/vnd.oci.image.manifest.v1+json" };
    },
    manifestSize: async () => 5_000_000,
    deleteManifest: async (ref: { repository: string }, digest: string) => {
      if (failDelete) throw new RegistryError("unsupported", "la suppression d'images n'y est pas activée");
      deleted.push(`${ref.repository}@${digest}`);
      for (const [tag, d] of Object.entries(repos[ref.repository] ?? {})) if (d === digest) delete (repos[ref.repository] as Record<string, string>)[tag];
    },
  };

  const job = (digests: { source?: string; patched?: string }, status: string, n: number) =>
    pool.query(
      `INSERT INTO remediation_jobs (image_id, platform, host_id, image_ref, status, requested_by, registry_host, repository, source_tag, patched_tag, patch_number, source_digest, patched_digest)
       VALUES ($1, 'linux/amd64', $2, 'alpine:3.22', $3, 'test', $4, $5, 'src-abcdef', $6, $7, $8, $9) RETURNING id`,
      [sha(String(n)), hostId, status, HOST, REPO, `3.22-patch.${n}`, n, digests.source ?? null, digests.patched ?? null],
    );
  const list = async () => (await images.list()).repositories.find((r) => r.repository === REPO)!;
  const imageOf = async (digest: string) => (await list()).images.find((i) => i.digest === digest)!;

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    sharedDir = await mkdtemp(join(tmpdir(), "infra-shared-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir: join(tmpdir(), "infra-data-test"), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    const baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    await fetch(baseUrl + "/api/v1/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: built.setup.token, username: "boss@example.com", password: "mot-de-passe-solide-1" }) });
    const token = (await readFile(join(sharedDir, "bootstrap-token"), "utf8")).trim();
    agent = new WebSocket(baseUrl.replace("http", "ws") + "/agent/ws");
    await new Promise<void>((resolve, reject) => {
      agent.on("open", () => agent.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, agentVersion: "test", hostname: "h", capabilities: [], auth: { kind: "enrollment", token } })));
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          hostId = msg.agentId;
          resolve();
        }
      });
      agent.on("error", reject);
    });

    await pool.query("INSERT INTO app_settings (key, value) VALUES ('registry', $1)", [JSON.stringify({ stackId: "00000000-0000-4000-8000-000000000000", hostId, host: HOST, entryPoint: "websecure", certResolver: "le", network: "proxy" })]);
    await job({ source: D_SRC, patched: D_P1 }, "validated", 1);
    await job({ source: D_SRC, patched: D_P2 }, "validated", 2);

    // Révision 1 : image 1 ; révision 2 (courante) : image 2. L'image 1 n'est donc plus qu'un retour arrière possible.
    const created = await createStack(pool, { name: "shop", hostId, description: "", compose: `services:\n  web:\n    image: ${HOST}/${REPO}@${D_P1}\n`, variables: {}, author: "test" });
    stackId = created.id;
    await changeStack(pool, stackId, 1, "test", "image 2", (c) => ({ ...c, compose: `services:\n  web:\n    image: ${HOST}/${REPO}@${D_P2}\n` }));
    images = new RegistryImages(pool, fake);
  });
  afterAll(async () => {
    agent.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  it("classe les images : corrigées, copie source, hors console", async () => {
    const view = await images.list();
    expect(view).toMatchObject({ registry: HOST, reachable: true, gcCommand: expect.stringContaining("garbage-collect") });
    const repo = await list();
    expect(repo.managed).toBe(true);
    expect(await imageOf(D_P1)).toMatchObject({ kind: "patched", tags: ["3.22-patch.1"], sizeBytes: 5_000_000, remediation: { status: "validated" } });
    expect(await imageOf(D_SRC)).toMatchObject({ kind: "source", tags: ["src-abcdef"] });
    const other = view.repositories.find((r) => r.repository === "autre/chose")!;
    expect(other.managed).toBe(false);
    expect(other.images[0]).toMatchObject({ kind: "other", deletable: false });
    expect(view.totalBytes).toBe(5_000_000 * 4);
  });

  it("protège l'image de la révision courante, signale celle d'une révision plus ancienne", async () => {
    const p2 = await imageOf(D_P2);
    expect(p2.deletable).toBe(false);
    expect(p2.blockers.join(" ")).toContain("Révision courante r2 de « shop »");
    const p1 = await imageOf(D_P1);
    expect(p1.deletable).toBe(true);
    expect(p1.history).toEqual([expect.objectContaining({ stackName: "shop", revision: 1, kind: "history" })]);
    // Une copie source n'est référencée par personne : suppression directe.
    expect((await imageOf(D_SRC)).deletable).toBe(true);
  });

  it("refuse de supprimer une image utilisée, hors périmètre ou inconnue", async () => {
    await expect(images.remove({ repository: REPO, digest: D_P2 }, "admin")).rejects.toMatchObject({ status: 409, code: "image_in_use" });
    await expect(images.remove({ repository: "autre/chose", digest: D_OTHER }, "admin")).rejects.toMatchObject({ status: 409, code: "not_managed" });
    await expect(images.remove({ repository: REPO, digest: sha("7") }, "admin")).rejects.toMatchObject({ status: 404 });
    expect(deleted).toEqual([]);
  });

  it("exige une confirmation pour une image que d'anciennes révisions référencent", async () => {
    await expect(images.remove({ repository: REPO, digest: D_P1 }, "admin")).rejects.toMatchObject({ status: 409, code: "history_requires_confirmation" });
    expect(deleted).toEqual([]);
  });

  it("signale l'échec quand le registre n'autorise pas la suppression", async () => {
    failDelete = "405";
    await expect(images.remove({ repository: REPO, digest: D_P1, acceptHistory: true }, "admin")).rejects.toMatchObject({ status: 502, code: "registry_delete_failed" });
    failDelete = null;
    expect((await pool.query("SELECT 1 FROM remediation_jobs WHERE patched_digest = $1 AND registry_deleted_at IS NOT NULL", [D_P1])).rowCount).toBe(0);
  });

  it("supprime par digest, marque le correctif et trace l'action", async () => {
    const result = await images.remove({ repository: REPO, digest: D_P1, acceptHistory: true }, "boss@example.com");
    expect(result).toMatchObject({ deleted: true, tags: ["3.22-patch.1"] });
    expect(deleted).toEqual([`${REPO}@${D_P1}`]);
    const row = await pool.query<{ registry_deleted_at: Date | null }>("SELECT registry_deleted_at FROM remediation_jobs WHERE patched_digest = $1", [D_P1]);
    expect(row.rows[0]?.registry_deleted_at).not.toBeNull();
    const other = await pool.query("SELECT registry_deleted_at FROM remediation_jobs WHERE patched_digest = $1", [D_P2]);
    expect(other.rows[0]?.registry_deleted_at).toBeNull();
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'registry.image.delete'")).rowCount).toBe(1);
    expect((await list()).images.map((i) => i.digest)).not.toContain(D_P1);
  });

  it("un correctif dont l'image est supprimée n'est plus utilisable dans une application", async () => {
    const id = (await pool.query<{ id: string }>("SELECT id FROM remediation_jobs WHERE patched_digest = $1", [D_P1])).rows[0]!.id;
    expect(await built.remediation.get(id)).toMatchObject({ status: "validated", imageDeleted: true });
    await expect(new RemediationApply(pool, built.remediation).targets(id)).rejects.toMatchObject({ status: 409, code: "remediation_not_usable" });
  });

  it("bloque tout le dépôt tant qu'un correctif est en cours", async () => {
    await job({}, "patching", 3);
    expect((await imageOf(D_SRC)).deletable).toBe(false);
    expect((await imageOf(D_SRC)).blockers.join(" ")).toContain("correctif est en cours");
    await expect(images.remove({ repository: REPO, digest: D_SRC }, "admin")).rejects.toMatchObject({ status: 409, code: "image_in_use" });
  });

  it("la liste de l'API de lecture est mise en cache quelques secondes, et relue à neuf après une suppression", async () => {
    await pool.query("DELETE FROM remediation_jobs WHERE status = 'patching'"); // le correctif actif du test précédent bloquerait la suppression
    let catalogCalls = 0;
    const counting = new RegistryImages(pool, { ...fake, catalog: async () => (catalogCalls++, fake.catalog()) });
    const t0 = 1_000_000;
    // Appels simultanés : un seul passage sur le registre.
    await Promise.all([counting.listCached(t0), counting.listCached(t0), counting.listCached(t0 + 100)]);
    expect(catalogCalls).toBe(1);
    await counting.listCached(t0 + 9_000);
    expect(catalogCalls).toBe(1);
    await counting.listCached(t0 + 10_500);
    expect(catalogCalls).toBe(2);
    // Une suppression invalide le cache.
    await counting.remove({ repository: REPO, digest: D_SRC }, "admin");
    await counting.listCached(t0 + 10_600);
    expect(catalogCalls).toBeGreaterThanOrEqual(4); // remove relit à neuf, puis la liste est recalculée
    // Un échec n'est pas conservé.
    let fail = true;
    const flaky = new RegistryImages(pool, { ...fake, catalog: async () => { if (fail) throw new RegistryError("network", "Registre injoignable."); return fake.catalog(); } });
    expect((await flaky.listCached(t0)).reachable).toBe(false);
    fail = false;
    expect((await flaky.listCached(t0 + 1)).reachable).toBe(false); // l'échec (une vue « injoignable ») reste en cache 10 s : pas de martèlement
    expect((await flaky.listCached(t0 + 11_000)).reachable).toBe(true);
  });

  it("signale un registre injoignable sans lever d'erreur", async () => {
    const down = new RegistryImages(pool, { ...fake, catalog: async () => { throw new RegistryError("network", "Registre injoignable."); } });
    expect(await down.list()).toMatchObject({ reachable: false, error: "Registre injoignable.", repositories: [] });
    await expect(down.remove({ repository: REPO, digest: D_SRC }, "admin")).rejects.toMatchObject({ status: 502 });
  });
});
