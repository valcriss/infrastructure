import type { DiskUsageMessage, PruneMessage, PruneProgress } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { buildDiskUsage, parseDf, type NetworkInfo } from "./disk-usage.js";
import { Pruner } from "./pruner.js";

const sha = (c: string) => `sha256:${c.repeat(64)}`;
const NOW = Date.parse("2026-11-07T12:00:00Z");

const classicDf = {
  Images: [
    { Id: sha("a"), RepoTags: ["app:1"], Created: 1000, Size: 100, SharedSize: 10, Containers: 1 },
    { Id: sha("b"), RepoTags: ["old:1"], Created: 2000, Size: 300, SharedSize: 0, Containers: 0 },
    { Id: sha("c"), RepoTags: [], Created: 3000, Size: 50, SharedSize: 0, Containers: 0 },
    { Id: sha("d"), RepoTags: ["ghcr.io/aquasecurity/trivy:0.76.1"], Created: 4000, Size: 70, SharedSize: 0, Containers: 0 },
  ],
  Containers: [
    { Id: "1".repeat(64), Names: ["/web-1"], Image: "app:1", State: "running", Created: 10, SizeRw: 5, Labels: { "com.docker.compose.project": "shop" } },
    { Id: "2".repeat(64), Names: ["/migrate-1"], Image: "app:1", State: "exited", Created: 20, SizeRw: 7, Labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": "migrate" } },
    { Id: "3".repeat(64), Names: ["/console-1"], Image: "c", State: "exited", Created: 30, SizeRw: 9, Labels: { "com.docker.compose.project": "console-docker" } },
    { Id: "4".repeat(64), Names: ["/paused"], Image: "x", State: "paused", Created: 40, SizeRw: 1, Labels: {} },
  ],
  Volumes: [
    { Name: "f".repeat(64), Labels: { "com.docker.volume.anonymous": "" }, CreatedAt: "2026-11-01T00:00:00Z", UsageData: { RefCount: 0, Size: 500 } },
    { Name: "shop_db", Labels: { "com.docker.compose.project": "shop" }, CreatedAt: "2026-10-01T00:00:00Z", UsageData: { RefCount: 0, Size: 900 } },
    { Name: "in-use", Labels: {}, UsageData: { RefCount: 1, Size: 400 } },
    { Name: "console-docker-trivy-cache", Labels: {}, UsageData: { RefCount: 0, Size: 800 } },
    { Name: "console-docker_data", Labels: { "com.docker.compose.project": "console-docker" }, UsageData: { RefCount: 0, Size: 600 } },
  ],
  BuildCache: [
    { ID: "b1", Type: "regular", InUse: false, Size: 1000, LastUsedAt: "2026-10-01T00:00:00Z", Description: "COPY . ." },
    { ID: "b2", Type: "regular", InUse: true, Size: 2000, LastUsedAt: "2026-11-07T00:00:00Z" },
  ],
};
const networks: NetworkInfo[] = [
  { id: "n1".padEnd(12, "0"), name: "shop_default", created: null, project: "shop", inUse: false },
  { id: "n2".padEnd(12, "0"), name: "console-docker_internal", created: null, project: "console-docker", inUse: false },
  { id: "n3".padEnd(12, "0"), name: "busy", created: null, project: "", inUse: true },
];

const build = () => buildDiskUsage(parseDf(classicDf), networks, { protectedProjects: new Set(["console-docker"]), protectedImageRefs: ["ghcr.io/aquasecurity/trivy:0.76.1"], now: NOW });

describe("buildDiskUsage", () => {
  it("ne propose que ce qui est inutilisé, et jamais ce qui appartient à la console ou à Trivy", () => {
    const d = build();
    expect(d.candidates.containers.map((c) => c.name)).toEqual(["migrate-1"]); // ni en marche, ni en pause, ni console
    expect(d.candidates.images.map((i) => i.ref)).toEqual(["old:1", expect.stringContaining("cccccccccccc")]); // ni utilisée, ni Trivy
    expect(d.candidates.images.find((i) => i.dangling)?.id).toBe(sha("c"));
    expect(d.candidates.networks.map((n) => n.name)).toEqual(["shop_default"]); // ni utilisé, ni console
    expect(d.candidates.volumes.map((v) => v.name)).toEqual(["shop_db", "f".repeat(64)]); // trié par taille ; ni utilisé, ni cache Trivy, ni console
    expect(d.candidates.buildCache.map((b) => b.id)).toEqual(["b1"]); // pas celui en cours d'utilisation
  });

  it("distingue les volumes anonymes des volumes nommés", () => {
    const v = build().candidates.volumes;
    expect(v.find((x) => x.name === "shop_db")).toMatchObject({ anonymous: false, project: "shop" });
    expect(v.find((x) => x.name === "f".repeat(64))).toMatchObject({ anonymous: true });
  });

  it("calcule le résumé comme docker system df (récupérable = inutilisé)", () => {
    const s = build().summary;
    expect(s.images).toMatchObject({ count: 4, sizeBytes: 520, reclaimableBytes: 420 }); // 300 + 50 + 70 (Trivy est comptée par Docker)
    expect(s.volumes.reclaimableBytes).toBe(500 + 900 + 800 + 600);
    expect(s.buildCache).toMatchObject({ count: 2, sizeBytes: 3000, reclaimableBytes: 1000 });
  });

  it("préfère les totaux calculés par Docker 29 (objets *Usage) quand ils existent", () => {
    const parsed = parseDf({ ...classicDf, ImageUsage: { TotalCount: 22, TotalSize: 9999, Reclaimable: 1234, Items: classicDf.Images } });
    const d = buildDiskUsage(parsed, [], { protectedProjects: new Set(), protectedImageRefs: [], now: NOW });
    expect(d.summary.images).toEqual({ count: 22, sizeBytes: 9999, reclaimableBytes: 1234 });
  });

  it("accepte la forme *Usage seule (sans les anciennes listes)", () => {
    const parsed = parseDf({ ImageUsage: { Items: classicDf.Images }, ContainerUsage: { Items: classicDf.Containers }, VolumeUsage: { Items: classicDf.Volumes }, BuildCacheUsage: { Items: classicDf.BuildCache } });
    expect(parsed.images).toHaveLength(4);
    expect(parsed.volumes).toHaveLength(5);
  });
});

describe("Pruner", () => {
  const usage: DiskUsageMessage = build();
  const calls: string[] = [];
  const msg = (targets: PruneMessage["targets"]): PruneMessage => ({ type: "prune", operationId: "7b9b6a34-0f5c-4c2b-8f3e-111111111111", targets });
  const pruner = (status: (path: string) => number, extra: { get?: (p: string) => Promise<unknown> } = {}) => {
    calls.length = 0;
    return new Pruner({
      socket: "s",
      collect: async () => usage,
      request: async (method, path) => {
        calls.push(`${method} ${path}`);
        const s = status(path);
        return { status: s, body: path.startsWith("/build/prune") ? { CachesDeleted: ["b1"], SpaceReclaimed: 1000 } : s >= 400 ? { message: "refusé par Docker" } : null };
      },
      ...extra,
    });
  };

  it("ne supprime que ce qui est encore candidat, sans jamais forcer ni emporter les volumes d'un conteneur", async () => {
    const r = await pruner(() => 204).run(
      msg({ containers: ["2".repeat(64), "1".repeat(64)], images: [], networks: [], volumes: ["shop_db", "in-use", "console-docker-trivy-cache"] }),
    );
    expect(r.status).toBe("succeeded");
    expect(r.removed).toMatchObject({ containers: 1, volumes: 1 });
    expect(calls).toEqual([`DELETE /containers/${"2".repeat(64)}?v=0&force=0`, "DELETE /volumes/shop_db?force=0"]);
    expect(r.skipped.join(" ")).toContain("en marche, protégé"); // le conteneur en marche
    expect(r.skipped.join(" ")).toContain("in-use");
    expect(r.skipped.join(" ")).toContain("console-docker-trivy-cache"); // le cache de Trivy est protégé
    expect(r.reclaimedBytes).toBe(7 + 900);
  });

  it("remonte les refus de Docker (élément utilisé) sans s'arrêter", async () => {
    const r = await pruner((p) => (p.startsWith("/volumes/") ? 409 : 204)).run(msg({ containers: ["2".repeat(64)], images: [], networks: [], volumes: ["shop_db"] }));
    expect(r.status).toBe("succeeded");
    expect(r.removed.containers).toBe(1);
    expect(r.errors[0]).toContain("shop_db");
    expect(r.errors[0]).toContain("refusé par Docker");
  });

  it("retire les étiquettes une à une quand une image en a plusieurs", async () => {
    let first = true;
    const r = await pruner(
      (p) => {
        if (p.startsWith("/images/sha256")) return first ? ((first = false), 409) : 200;
        return 200;
      },
      { get: async () => ({ RepoTags: ["old:1", "old:latest"] }) },
    ).run(msg({ containers: [], images: [sha("b")], networks: [], volumes: [] }));
    expect(r.removed.images).toBe(1);
    expect(calls.filter((c) => c.includes("old%3A"))).toHaveLength(2);
  });

  it("nettoie le cache de build avec la date limite et le stockage à conserver, et rapporte l'espace réellement libéré", async () => {
    const r = await pruner(() => 200).run(msg({ containers: [], images: [], networks: [], volumes: [], buildCache: { mode: "older", olderThanHours: 168, keepBytes: 2e9 } }));
    const call = decodeURIComponent(calls[0] as string);
    expect(call).toContain("POST /build/prune?all=true");
    expect(call).toContain('"until":["168h"]');
    expect(call).toContain("keep-storage=2000000000");
    expect(r.removed.buildCache).toBe(1);
    expect(r.reclaimedBytes).toBe(1000);
  });

  it("rapporte l'avancement : phase, élément en cours avant sa suppression, compteurs, puis la fin de chaque phase", async () => {
    const events: PruneProgress[] = [];
    let clock = 0;
    const p = new Pruner({
      socket: "s",
      now: () => clock, // l'horloge ne bouge pas : seuls les débuts et fins de phase sont rapportés (limitation de débit)
      collect: async () => usage,
      request: async (_m, path) => ({ status: path.startsWith("/build/prune") ? 200 : 204, body: path.startsWith("/build/prune") ? { CachesDeleted: ["b1"], SpaceReclaimed: 1000 } : null }),
    });
    await p.run(msg({ containers: ["2".repeat(64)], images: [], networks: ["n1".padEnd(12, "0")], volumes: ["shop_db", "f".repeat(64)], buildCache: { mode: "all" } }), (e) => events.push(e));

    const first = events[0] as PruneProgress;
    expect(first).toMatchObject({ phase: "containers", done: 0, total: 1, current: "migrate-1", overall: { done: 0, total: 5 } }); // 1 conteneur + 1 réseau + 2 volumes + le cache
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe("containers");
    expect(phases).toContain("networks");
    expect(phases).toContain("volumes");
    expect(phases.at(-1)).toBe("buildCache");
    // Le cache de build est annoncé avant l'appel (un seul bloc, peut être long), avec sa taille.
    expect(events.find((e) => e.phase === "buildCache")).toMatchObject({ done: 0, current: "cache de build", buildCacheBytes: 1000 });
    const last = events.at(-1) as PruneProgress;
    expect(last).toMatchObject({ done: 1, total: 1, overall: { done: 5, total: 5 }, removed: { containers: 1, networks: 1, volumes: 2, buildCache: 1 } });
    expect(last.reclaimedBytes).toBe(7 + 900 + 500 + 1000);
    // Limitation de débit : bien moins de messages que d'éléments à chaque tour de boucle.
    clock = 10_000;
    expect(events.length).toBeLessThanOrEqual(12);
  });

  it("n'annonce que les éléments encore supprimables dans le total (les autres sont ignorés)", async () => {
    const events: PruneProgress[] = [];
    await pruner(() => 204).run(msg({ containers: ["2".repeat(64), "1".repeat(64)], images: [], networks: [], volumes: ["in-use"] }), (e) => events.push(e));
    expect(events[0]?.overall.total).toBe(1); // le conteneur en marche et le volume utilisé ne comptent pas
  });

  it("échoue proprement si Docker est injoignable", async () => {
    const p = new Pruner({ socket: "s", collect: async () => Promise.reject(new Error("socket indisponible")), request: async () => ({ status: 204, body: null }) });
    const r = await p.run(msg({ containers: ["2".repeat(64)], images: [], networks: [], volumes: [] }));
    expect(r).toMatchObject({ status: "failed", error: "socket indisponible" });
  });
});
