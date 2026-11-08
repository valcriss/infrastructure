import { describe, expect, it } from "vitest";
import { parseImageRef } from "./image-ref.js";
import { dropOlder, suspiciousJump, type DateClient } from "./tag-dates.js";

const ref = parseImageRef("lscr.io/linuxserver/qbittorrent:5.3.0")!;
const linux = { os: "linux", arch: "amd64" };
const d = (y: number) => Date.UTC(y, 5, 1);

/** Registre factice : date de création par tag ; undefined = indéterminable ; lève si le tag est absent. */
const fake = (dates: Record<string, number | undefined>): DateClient & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    resolvePlatform: async (_r, tag) => {
      calls.push(tag);
      if (!(tag in dates)) throw new Error("absent");
      return { manifestDigest: "m", configDigest: `cfg-${tag}`, indexDigest: null };
    },
    configCreated: async (_r, digest) => dates[digest.slice(4)] ?? null,
  };
};

describe("dropOlder", () => {
  it("écarte les versions plus anciennes que l'image actuelle malgré un numéro plus grand", async () => {
    const c = fake({ "5.3.0": d(2026), "20.04.1": d(2020), "14.3.9": d(2020), "5.4.0": d(2026) });
    const r = await dropOlder(c, ref, "5.3.0", ["20.04.1", "14.3.9", "5.4.0"], linux);
    expect(r).toMatchObject({ kept: ["5.4.0"], older: ["20.04.1", "14.3.9"], checked: true });
    expect(r.notes.join(" ")).toMatch(/plus ancienne/);
  });

  it("garde une version dont la date est indisponible, en le signalant", async () => {
    const c = fake({ "5.3.0": d(2026), "5.4.0": undefined });
    const r = await dropOlder(c, ref, "5.3.0", ["5.4.0"], linux);
    expect(r.kept).toEqual(["5.4.0"]);
    expect(r.notes.join(" ")).toMatch(/indisponible/);
  });

  it("sans date de l'image actuelle ou sans plateforme : n'écarte que les sauts de version suspects", async () => {
    const noCurrent = await dropOlder(fake({ "5.4.0": d(2026) }), ref, "5.3.0", ["20.04.1", "5.4.0"], linux);
    expect(noCurrent).toMatchObject({ kept: ["5.4.0"], suspicious: ["20.04.1"], checked: false });
    const noPlatform = await dropOlder(fake({}), ref, "5.3.0", ["14.3.9", "5.3.1"], null);
    expect(noPlatform).toMatchObject({ kept: ["5.3.1"], suspicious: ["14.3.9"], checked: false });
  });

  it("ne lève jamais et garde la liste si le registre échoue", async () => {
    const broken: DateClient = { resolvePlatform: async () => { throw new Error("réseau"); }, configCreated: async () => null };
    const r = await dropOlder(broken, ref, "5.3.0", ["5.4.0", "6.0.0"], linux);
    expect(r.kept).toEqual(["5.4.0", "6.0.0"]);
    const noMethod = await dropOlder({ resolvePlatform: broken.resolvePlatform }, ref, "5.3.0", ["5.4.0"], linux);
    expect(noMethod.kept).toEqual(["5.4.0"]);
  });

  it("réutilise les dates déjà lues (cache par client)", async () => {
    const c = fake({ "5.3.0": d(2026), "5.4.0": d(2026) });
    await dropOlder(c, ref, "5.3.0", ["5.4.0"], linux);
    const first = c.calls.length;
    await dropOlder(c, ref, "5.3.0", ["5.4.0"], linux);
    expect(c.calls.length).toBe(first);
  });

  it("liste vide : aucune requête", async () => {
    const c = fake({});
    expect((await dropOlder(c, ref, "5.3.0", [], linux)).kept).toEqual([]);
    expect(c.calls).toEqual([]);
  });
});

describe("suspiciousJump", () => {
  it("repère un saut majeur incohérent, pas une montée normale", () => {
    expect(suspiciousJump("5.3.0", "20.04.1")).toBe(true);
    expect(suspiciousJump("5.3.0", "14.3.9")).toBe(true);
    expect(suspiciousJump("5.3.0", "6.0.0")).toBe(false);
    expect(suspiciousJump("120.1.0", "125.0.0")).toBe(false);
    expect(suspiciousJump("latest", "20.1")).toBe(false);
  });
});
