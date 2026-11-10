import type { Container, ImageInfo } from "@infra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import type { RegistryLike } from "./image-watch.js";
import { ObservedWatcher } from "./observed-watch.js";
import { RegistryError } from "./registry.js";

const url = process.env.TEST_DATABASE_URL;
const sha = (c: string) => "sha256:" + c.repeat(64);
const DIGEST = sha("1");
const IMAGE_ID = sha("a");

const client = (over: Partial<Record<keyof RegistryLike, unknown>> = {}): RegistryLike =>
  ({
    headManifest: async () => ({ digest: DIGEST, mediaType: "x" }),
    resolvePlatform: async () => ({ manifestDigest: sha("2"), configDigest: IMAGE_ID, indexDigest: DIGEST }),
    configLayers: async () => [],
    listTags: async () => ({ tags: ["1.27.0", "1.27.1", "1.28.0", "2.0.0", "latest"], truncated: false }),
    ...over,
  }) as never;

const ctr = (service: string, image: string, imageId: string): Container => ({
  id: `c-${service}`,
  names: [`blog-${service}-1`],
  image,
  imageId,
  state: "running",
  status: "Up",
  created: 1,
  composeProject: "blog",
  composeService: service,
});
const img = (id: string, ref: string): ImageInfo => ({ id, repoTags: [ref], repoDigests: [`${ref.split(":")[0]}@${DIGEST}`], size: 1, os: "linux", arch: "amd64" });

describe.skipIf(!url)("suivi des mises à jour des applications observées (intégration)", () => {
  let pool: Pool;
  let hostId = "";

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    hostId = (
      await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash, inventory, images) VALUES ('h', 'x', $1, $2) RETURNING id", [
        JSON.stringify([ctr("web", "nginx:1.27.0", IMAGE_ID), ctr("db", "postgres:16.1", sha("b"))]),
        JSON.stringify([img(IMAGE_ID, "nginx:1.27.0"), img(sha("b"), "postgres:16.1")]),
      ])
    ).rows[0]?.id as string;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("applique la règle de suivi du service, puis écarte une version sans interroger le registre", async () => {
    const w = new ObservedWatcher(pool, client());
    await w.checkProject(hostId, "blog");
    let web = (await w.checks(hostId, "blog")).find((c) => c.service === "web");
    // Règle par défaut « même tag » : aucun nouveau tag n'est cherché.
    expect(web).toMatchObject({ status: "ok", kind: "up_to_date" });
    expect(web?.detail?.candidates).toEqual([]);

    await w.setPolicy(hostId, "blog", "web", "minor", null, "alice");
    expect((await w.policies(hostId, "blog")).web).toEqual({ policy: "minor", pattern: null });
    await w.checkProject(hostId, "blog");
    web = (await w.checks(hostId, "blog")).find((c) => c.service === "web");
    expect(web?.kind).toBe("update_available");
    expect(web?.detail?.candidates).toEqual(expect.arrayContaining(["1.27.1", "1.28.0"]));
    expect(web?.detail?.candidates).not.toContain("2.0.0");

    await w.ignoreTag(hostId, "blog", "web", "1.28.0", "incompatible", "alice");
    web = (await w.checks(hostId, "blog")).find((c) => c.service === "web");
    expect(web?.detail?.candidates).not.toContain("1.28.0");
    expect(web?.detail?.ignored).toContain("1.28.0");
    expect((await w.ignoredTags(hostId, "blog")).web?.[0]).toMatchObject({ tag: "1.28.0", reason: "incompatible", createdBy: "alice" });

    await w.ignoreTag(hostId, "blog", "web", "1.27.1", null, "alice");
    expect((await w.checks(hostId, "blog")).find((c) => c.service === "web")?.kind).toBe("up_to_date");
    await w.unignoreTag(hostId, "blog", "web", "1.27.1", "alice");
    await expect(w.unignoreTag(hostId, "blog", "web", "1.27.1", "alice")).rejects.toMatchObject({ status: 404 });
  });

  it("refuse une règle invalide ou un service inconnu", async () => {
    const w = new ObservedWatcher(pool, client());
    await expect(w.setPolicy(hostId, "blog", "web", "pattern", "(a+)+$", "alice")).rejects.toBeInstanceOf(HttpError);
    await expect(w.setPolicy(hostId, "blog", "inconnu", "minor", null, "alice")).rejects.toMatchObject({ status: 404 });
    await expect(w.setPolicy(hostId, "absent", "web", "minor", null, "alice")).rejects.toMatchObject({ status: 404 });
  });

  it("conserve la dernière observation quand le registre échoue", async () => {
    const ok = new ObservedWatcher(pool, client());
    await ok.checkProject(hostId, "blog");
    const failing = new ObservedWatcher(pool, client({ headManifest: async () => { throw new RegistryError("unavailable", "registre injoignable"); } }));
    await failing.checkProject(hostId, "blog");
    const db = (await failing.checks(hostId, "blog")).find((c) => c.service === "db");
    expect(db).toMatchObject({ status: "error", error: "registre injoignable", kind: expect.any(String) });
    expect(db?.lastSuccessAt).not.toBeNull();
  });

  it("revérifie les projets non gérés selon l'intervalle et ignore ceux d'une stack", async () => {
    const w = new ObservedWatcher(pool, client());
    await pool.query("DELETE FROM observed_image_checks");
    expect(await w.scheduledPass()).toBe(1);
    // Vérifié à l'instant : rien à refaire.
    expect(await w.scheduledPass()).toBe(0);
    // Plus tard que l'intervalle par défaut.
    expect(await w.scheduledPass(Date.now() + 30 * 24 * 3600_000)).toBe(1);

    await pool.query("INSERT INTO stacks (name, host_id) VALUES ('blog', $1)", [hostId]);
    expect(await w.scheduledPass(Date.now() + 90 * 24 * 3600_000)).toBe(0);
  });
});
