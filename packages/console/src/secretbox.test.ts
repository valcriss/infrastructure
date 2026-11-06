import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SecretBox, loadOrCreateMasterKey } from "./secretbox.js";

describe("SecretBox", () => {
  it("chiffre et déchiffre, avec un résultat différent à chaque appel", () => {
    const box = new SecretBox(randomBytes(32));
    const a = box.seal("jeton-secret");
    expect(a).not.toContain("jeton-secret");
    expect(box.open(a)).toBe("jeton-secret");
    expect(box.seal("jeton-secret")).not.toBe(a);
  });

  it("refuse une autre clé et un contenu altéré", () => {
    const sealed = new SecretBox(randomBytes(32)).seal("x");
    expect(() => new SecretBox(randomBytes(32)).open(sealed)).toThrow();
    const box = new SecretBox(randomBytes(32));
    const good = box.seal("x");
    expect(() => box.open(good.slice(0, -2) + "AA")).toThrow();
    expect(() => box.open("n'importe quoi")).toThrow();
  });

  it("calcule un HMAC stable et dépendant de la clé", () => {
    const k = randomBytes(32);
    expect(new SecretBox(k).hmac("a")).toBe(new SecretBox(k).hmac("a"));
    expect(new SecretBox(k).hmac("a")).not.toBe(new SecretBox(randomBytes(32)).hmac("a"));
  });
});

describe("clé maître", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("est créée une fois puis relue à l'identique", async () => {
    dir = await mkdtemp(join(tmpdir(), "infra-key-"));
    const [a, b] = await Promise.all([loadOrCreateMasterKey(dir), loadOrCreateMasterKey(dir)]);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
    expect((await loadOrCreateMasterKey(dir)).equals(a)).toBe(true);
    expect((await readFile(join(dir, "master.key"), "utf8")).trim()).toHaveLength(64);
  });
});
