import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeDotenv, encodeDotenvValue } from "./dotenv.js";
import { LineBuffer } from "./exec.js";
import { parseComposePs } from "./executor.js";
import { syncStackDir } from "./workspace.js";

describe("dotenv", () => {
  it("utilise des guillemets simples quand c'est possible", () => {
    expect(encodeDotenvValue("a $b \\ c # d")).toBe("'a $b \\ c # d'");
  });
  it("échappe \\, \" et $ quand la valeur contient une apostrophe", () => {
    expect(encodeDotenvValue(`it's $HOME \\ "x"`)).toBe(`"it's \\$HOME \\\\ \\"x\\""`);
  });
  it("trie les variables et rejette les noms ou valeurs invalides", () => {
    expect(encodeDotenv({ B: "2", A: "1" })).toContain("A='1'\nB='2'");
    expect(() => encodeDotenv({ "1BAD": "x" })).toThrow();
    expect(() => encodeDotenv({ OK: "a\nb" })).toThrow();
  });
});

describe("LineBuffer", () => {
  it("n'émet que des lignes complètes et masque un secret coupé entre deux paquets", async () => {
    const out: string[] = [];
    const buf = new LineBuffer(
      (t) => out.push(t),
      (l) => l.split("hunter2-secret").join("***"),
      5,
    );
    buf.push("mot de passe : hunter2-");
    buf.push("secret fin\nsuite");
    buf.end();
    const all = out.join("");
    expect(all).not.toContain("hunter2");
    expect(all).toContain("mot de passe : *** fin");
    expect(all).toContain("suite");
  });
});

describe("parseComposePs", () => {
  it("lit le format NDJSON et le format tableau", () => {
    const a = '{"Service":"web","State":"running","Health":"healthy"}\n{"Service":"db","State":"exited"}\n';
    expect(parseComposePs(a)).toEqual([
      { service: "web", state: "running", health: "healthy" },
      { service: "db", state: "exited" },
    ]);
    expect(parseComposePs('[{"Service":"x","State":"running"}]')).toEqual([{ service: "x", state: "running" }]);
    expect(parseComposePs("")).toEqual([]);
  });
});

describe("syncStackDir", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "infra-ws-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const base = { compose: "services: {}\n", env: "A='1'\n" };

  it("écrit compose, .env et fichiers associés", async () => {
    const dir = join(root, "s1");
    await syncStackDir(dir, { ...base, files: { "conf/app.conf": "x=1" } });
    expect(await readFile(join(dir, "compose.yaml"), "utf8")).toBe(base.compose);
    expect(await readFile(join(dir, "conf/app.conf"), "utf8")).toBe("x=1");
  });

  it("supprime les fichiers retirés mais pas les données qui ne lui appartiennent pas", async () => {
    const dir = join(root, "s2");
    await syncStackDir(dir, { ...base, files: { "conf/a.conf": "1", "b.txt": "2" } });
    await writeFile(join(dir, "donnees.db"), "à conserver");
    await syncStackDir(dir, { ...base, files: { "b.txt": "2" } });
    expect(existsSync(join(dir, "conf/a.conf"))).toBe(false);
    expect(existsSync(join(dir, "conf"))).toBe(false);
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
    expect(await readFile(join(dir, "donnees.db"), "utf8")).toBe("à conserver");
  });

  it("refuse les chemins qui sortent du dossier", async () => {
    await expect(syncStackDir(join(root, "s3"), { ...base, files: { "../evil": "x" } })).rejects.toThrow();
    await expect(syncStackDir(join(root, "s3"), { ...base, files: { "/etc/x": "x" } })).rejects.toThrow();
  });

  it("refuse d'écrire à travers un lien symbolique", async () => {
    const dir = join(root, "s4");
    const outside = join(root, "dehors");
    await mkdir(dir, { recursive: true });
    await mkdir(outside);
    try {
      await symlink(outside, join(dir, "lien"), "dir");
    } catch {
      return; // création de liens non permise sur cette machine (ex. Windows sans droit)
    }
    await expect(syncStackDir(dir, { ...base, files: { "lien/pwned.txt": "x" } })).rejects.toThrow(/symbolique/);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });
});
