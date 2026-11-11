import type { Container } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { buildStorage, mountSources, sizeKey, type MountSize } from "./storage.js";

const c = (id: string, service: string, mounts: NonNullable<Container["mounts"]>): Container => ({ id, names: [`/${service}`], composeService: service, mounts }) as unknown as Container;
const at = new Date("2026-11-11T10:00:00Z");

describe("stockage des montages", () => {
  const containers = [
    c("a1", "web", [{ type: "volume", source: "app_data", destination: "/data", rw: true }, { type: "bind", source: "/srv/init.sh", destination: "/init.sh", rw: false }]),
    c("b2", "worker", [{ type: "volume", source: "app_data", destination: "/shared", rw: true }, { type: "tmpfs", destination: "/tmp", rw: true }]),
  ];

  it("regroupe un volume partagé et compte sa taille une seule fois", () => {
    const sizes = new Map<string, MountSize>([
      [sizeKey("volume", "app_data"), { sizeBytes: 1000, note: null, measuredAt: at }],
      [sizeKey("bind", "/srv/init.sh"), { sizeBytes: 4096, note: null, measuredAt: at }],
    ]);
    const v = buildStorage(containers, sizes);
    expect(v.items).toHaveLength(4 - 1); // volume partagé, bind, tmpfs
    const shared = v.items.find((i) => i.source === "app_data");
    expect(shared?.usedBy.map((u) => u.service)).toEqual(["web", "worker"]);
    expect(v.totalBytes).toBe(5096);
    expect(v.unmeasured).toBe(0);
    expect(v.items[0]?.sizeBytes).toBe(4096); // tri : le plus gros d'abord
  });

  it("signale les montages non mesurés et un total partiel, ou absent", () => {
    const none = buildStorage(containers, new Map());
    expect(none.totalBytes).toBeNull();
    expect(none.unmeasured).toBe(2);
    const some = buildStorage(containers, new Map([[sizeKey("volume", "app_data"), { sizeBytes: 10, note: null, measuredAt: at }]]));
    expect(some.totalBytes).toBe(10);
    expect(some.unmeasured).toBe(1);
  });

  it("liste les sources à mesurer sans les mémoires ni les doublons", () => {
    expect(mountSources(containers)).toEqual({ volumes: ["app_data"], binds: ["/srv/init.sh"] });
  });
});
