import { generateIdentity, identityToRecipient } from "age-encryption";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupFormatError,
  InvalidKeyError,
  KeyRequiredError,
  SecretEncryptor,
  buildSnapshot,
  parseSnapshot,
  readWorkTree,
  type SnapshotInput,
} from "./backup-format.js";
import { SecretBox } from "./secretbox.js";

const SID = "11111111-1111-4111-8111-111111111111";
const SID2 = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const INSTALL = "44444444-4444-4444-8444-444444444444";

const compose = "services:\n  web:\n    image: nginx:1.27\n    ports:\n      - '${PORT}:80'\n";

const input = (): SnapshotInput => ({
  installationId: INSTALL,
  configRevision: 7,
  hosts: [{ id: HOST, name: "hôte local" }],
  stacks: [
    {
      id: SID,
      name: "app",
      hostId: HOST,
      description: "ma stack",
      revision: 3,
      content: {
        compose,
        variables: {
          PORT: { value: "8080", sensitive: false },
          DB_PASSWORD: { value: "tres-secret-123", sensitive: true },
        },
        files: { "conf/app.conf": "x=1", "tls/key.pem": "-----PRIVATE-----" },
        sensitiveFiles: ["tls/key.pem"],
        composeSensitive: false,
      },
    },
    {
      id: SID2,
      name: "secret-compose",
      hostId: HOST,
      description: "",
      revision: 1,
      content: { compose: compose + "    environment:\n      TOKEN: abc-compose-secret\n", variables: {}, files: {}, sensitiveFiles: [], composeSensitive: true },
    },
  ],
});

async function keys() {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

const encryptor = (recipient: string, cache = new Map()) => new SecretEncryptor(recipient, (v) => new SecretBox(Buffer.alloc(32, 1)).hmac(v), cache);

describe("format de sauvegarde Git v1", () => {
  it("exporte puis relit une configuration complète (aller-retour)", async () => {
    const { identity, recipient } = await keys();
    const files = await buildSnapshot(input(), encryptor(recipient));
    const parsed = await parseSnapshot(files, identity);

    expect(parsed).toMatchObject({ installationId: INSTALL, configRevision: 7, hasSecrets: true });
    expect(parsed.hosts).toEqual([{ id: HOST, name: "hôte local" }]);
    const app = parsed.stacks.find((s) => s.name === "app");
    expect(app?.content).toEqual(input().stacks[0]?.content);
    expect(app).toMatchObject({ id: SID, hostId: HOST, description: "ma stack", sourceRevision: 3 });
    expect(parsed.stacks.find((s) => s.name === "secret-compose")?.content.composeSensitive).toBe(true);
    expect(parsed.stacks.find((s) => s.name === "secret-compose")?.content.compose).toContain("abc-compose-secret");
  });

  it("n'écrit aucun secret en clair dans le dépôt", async () => {
    const { recipient } = await keys();
    const files = await buildSnapshot(input(), encryptor(recipient));
    const clear = [...files.entries()].filter(([p]) => !p.endsWith(".age"));
    for (const [path, text] of clear) {
      for (const secret of ["tres-secret-123", "PRIVATE", "abc-compose-secret"]) {
        expect(text, `${path} contient ${secret}`).not.toContain(secret);
      }
    }
    expect(files.has(`stacks/${SID2}/compose.yaml`)).toBe(false);
    expect(files.has(`secrets/${SID}/variables.age`)).toBe(true);
    expect(files.has(`secrets/${SID}/files/tls/key.pem.age`)).toBe(true);
    expect(files.get(`secrets/${SID}/variables.age`)).toContain("BEGIN AGE ENCRYPTED FILE");
  });

  it("est déterministe : un secret inchangé garde son texte chiffré", async () => {
    const { recipient } = await keys();
    const first = encryptor(recipient);
    const a = await buildSnapshot(input(), first);
    const second = encryptor(recipient, first.used);
    const b = await buildSnapshot(input(), second);
    expect([...b.entries()]).toEqual([...a.entries()]);

    const changed = input();
    (changed.stacks[0] as { content: { variables: Record<string, unknown> } }).content.variables.DB_PASSWORD = { value: "autre", sensitive: true };
    const c = await buildSnapshot(changed, encryptor(recipient, second.used));
    expect(c.get(`secrets/${SID}/variables.age`)).not.toBe(a.get(`secrets/${SID}/variables.age`));
    expect(c.get(`secrets/${SID}/files/tls/key.pem.age`)).toBe(a.get(`secrets/${SID}/files/tls/key.pem.age`));
  });

  it("exige la bonne clé de restauration", async () => {
    const { recipient } = await keys();
    const files = await buildSnapshot(input(), encryptor(recipient));
    await expect(parseSnapshot(files, null)).rejects.toBeInstanceOf(KeyRequiredError);
    await expect(parseSnapshot(files, (await keys()).identity)).rejects.toBeInstanceOf(InvalidKeyError);
    await expect(parseSnapshot(files, "pas-une-cle")).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it("n'exige pas de clé quand rien n'est chiffré", async () => {
    const { recipient } = await keys();
    const plain = input();
    plain.stacks = [{ ...(plain.stacks[0] as SnapshotInput["stacks"][0]), content: { compose, variables: { PORT: { value: "80", sensitive: false } }, files: {}, sensitiveFiles: [], composeSensitive: false } }];
    const parsed = await parseSnapshot(await buildSnapshot(plain, encryptor(recipient)), null);
    expect(parsed.hasSecrets).toBe(false);
    expect(parsed.stacks).toHaveLength(1);
  });

  it("rejette les dépôts altérés ou dangereux", async () => {
    const { identity, recipient } = await keys();
    const base = await buildSnapshot(input(), encryptor(recipient));
    const with_ = (mut: (m: Map<string, string>) => void) => {
      const m = new Map(base);
      mut(m);
      return parseSnapshot(m, identity);
    };

    await expect(with_((m) => m.set("stacks/x/evil.txt", "x"))).rejects.toThrow(/inattendu/);
    await expect(with_((m) => m.set(`stacks/${SID}/files/../../escape`, "x"))).rejects.toThrow(BackupFormatError);
    await expect(with_((m) => m.set(`stacks/${SID}/files/a\\b`, "x"))).rejects.toThrow(BackupFormatError);
    await expect(with_((m) => m.set("manifest.yaml", "formatVersion: 99\ninstallationId: " + INSTALL + "\nconfigRevision: 1\n"))).rejects.toThrow(/plus récent/);
    await expect(with_((m) => m.set(`stacks/${SID}/stack.yaml`, (m.get(`stacks/${SID}/stack.yaml`) ?? "").replace("name: app", "name: 'Nom Invalide'")))).rejects.toThrow(/Nom invalide/);
    await expect(with_((m) => m.set(`stacks/${SID}/compose.yaml`, "services:\n  web:\n    build: .\n"))).rejects.toThrow(/build/);
    await expect(with_((m) => m.set(`stacks/${SID}/variables.yaml`, "BAD NAME: 1\n"))).rejects.toThrow(BackupFormatError);
    await expect(with_((m) => m.set(`stacks/${SID}/variables.yaml`, "a: &x 1\nb: *x\n"))).rejects.toThrow(/YAML invalide/);
    await expect(with_((m) => m.delete(`stacks/${SID}/stack.yaml`))).rejects.toThrow(/manquant/);
    await expect(with_((m) => m.set(`stacks/${SID}/stack.yaml`, (m.get(`stacks/${SID}/stack.yaml`) ?? "") + "extra: 1\n"))).rejects.toThrow(BackupFormatError);
  });
});

describe("readWorkTree", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("lit uniquement le périmètre géré et préserve les fichiers étrangers", async () => {
    dir = await mkdtemp(join(tmpdir(), "infra-tree-"));
    await mkdir(join(dir, "stacks", SID), { recursive: true });
    await writeFile(join(dir, "manifest.yaml"), "a: 1\n");
    await writeFile(join(dir, "README.md"), "ignoré");
    await writeFile(join(dir, "stacks", SID, "stack.yaml"), "b: 2\n");
    const tree = await readWorkTree(dir);
    expect([...tree.keys()].sort()).toEqual(["manifest.yaml", `stacks/${SID}/stack.yaml`]);
  });

  it("refuse les liens symboliques", async () => {
    dir = await mkdtemp(join(tmpdir(), "infra-tree-"));
    await mkdir(join(dir, "stacks"), { recursive: true });
    await writeFile(join(dir, "secret.txt"), "hors périmètre");
    try {
      await symlink(join(dir, "secret.txt"), join(dir, "stacks", "lien.txt"));
    } catch {
      return; // création de liens non permise sur cette machine
    }
    await expect(readWorkTree(dir)).rejects.toThrow(/symbolique/);
  });
});

