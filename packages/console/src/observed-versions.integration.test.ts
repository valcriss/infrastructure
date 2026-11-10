import type { Container, Inventory } from "@infra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Pool } from "./db.js";
import { listObservedVersions, MAX_VERSIONS_PER_SERVICE, recordObservedVersions } from "./observed-versions.js";

const url = process.env.TEST_DATABASE_URL;

const ctr = (service: string, image: string, imageId: string, over: Partial<Container> = {}): Container => ({
  id: `c-${service}-${imageId}`,
  names: [`blog-${service}-1`],
  image,
  imageId,
  state: "running",
  status: "Up",
  created: 1,
  composeProject: "blog",
  composeService: service,
  ...over,
});
const inv = (containers: Container[], images: Inventory["images"] = []): Inventory => ({ observedAt: new Date().toISOString(), dockerVersion: "27", containers, images });

describe.skipIf(!url)("historique des versions observées (intégration)", () => {
  let pool: Pool;
  let hostId = "";

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    hostId = (await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash) VALUES ('h', 'x') RETURNING id")).rows[0]?.id as string;
  });
  afterAll(async () => {
    await pool.end();
  });

  it("n'écrit que lors d'un changement d'image ou de contenu, avec le digest quand il est connu", async () => {
    const images = [{ id: "sha256:aaa", repoTags: ["nginx:1.27"], repoDigests: ["nginx@sha256:d1"], size: 1 }];
    await recordObservedVersions(pool, hostId, inv([ctr("web", "nginx:1.27", "sha256:aaa")], images));
    await recordObservedVersions(pool, hostId, inv([ctr("web", "nginx:1.27", "sha256:aaa")], images));
    expect(await listObservedVersions(pool, hostId, "blog")).toHaveLength(1);

    // Même étiquette, contenu différent (étiquette republiée), puis nouvelle étiquette.
    await recordObservedVersions(pool, hostId, inv([ctr("web", "nginx:1.27", "sha256:bbb")]));
    await recordObservedVersions(pool, hostId, inv([ctr("web", "nginx:1.28", "sha256:ccc")]));
    const list = await listObservedVersions(pool, hostId, "blog");
    expect(list.map((v) => v.image)).toEqual(["nginx:1.28", "nginx:1.27", "nginx:1.27"]);
    expect(list[2]).toMatchObject({ digest: "sha256:d1", imageId: "sha256:aaa" });
    expect(list[0]?.digest).toBeNull();

    // Un projet qui disparaît puis revient à l'identique n'ajoute rien.
    await recordObservedVersions(pool, hostId, inv([]));
    await recordObservedVersions(pool, hostId, inv([ctr("web", "nginx:1.28", "sha256:ccc")]));
    expect(await listObservedVersions(pool, hostId, "blog")).toHaveLength(3);
  });

  it("ignore les projets gérés par une stack et borne l'historique", async () => {
    await pool.query("INSERT INTO stacks (name, host_id) VALUES ('gere', $1)", [hostId]);
    await recordObservedVersions(pool, hostId, inv([ctr("api", "api:1", "sha256:1", { composeProject: "gere" })]));
    expect(await listObservedVersions(pool, hostId, "gere")).toEqual([]);

    for (let i = 0; i < MAX_VERSIONS_PER_SERVICE + 5; i++) {
      await recordObservedVersions(pool, hostId, inv([ctr("worker", `w:${i}`, `sha256:${i}`)]));
    }
    const workers = (await listObservedVersions(pool, hostId, "blog")).filter((v) => v.service === "worker");
    expect(workers).toHaveLength(MAX_VERSIONS_PER_SERVICE);
    expect(workers[0]?.image).toBe(`w:${MAX_VERSIONS_PER_SERVICE + 4}`);
  });
});
