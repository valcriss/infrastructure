import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION = "v1";

/**
 * Chiffrement des secrets propres à la console (jeton Git) avec une clé maître
 * locale : AES-256-GCM (module `node:crypto`). La clé maître n'est jamais
 * écrite dans Git ni dans la base ; perdue, elle impose seulement de ressaisir
 * le jeton Git.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("clé maître invalide (32 octets attendus)");
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
  }

  open(sealed: string): string {
    const [version, payload] = sealed.split(":");
    if (version !== VERSION || !payload) throw new Error("format de secret inconnu");
    const raw = Buffer.from(payload, "base64url");
    if (raw.length < 28) throw new Error("secret tronqué");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }

  /** Empreinte à clé : identifie un contenu sans le révéler (cache de chiffrement). */
  hmac(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }
}

/** Charge la clé maître, ou la crée de façon atomique au premier démarrage. */
export async function loadOrCreateMasterKey(dataDir: string): Promise<Buffer> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "master.key");
  try {
    return Buffer.from((await readFile(file, "utf8")).trim(), "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  try {
    // `wx` : échoue si un autre processus a créé la clé entre-temps.
    await writeFile(file, key.toString("hex") + "\n", { flag: "wx", mode: 0o600 });
    await chmod(file, 0o600);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return Buffer.from((await readFile(file, "utf8")).trim(), "hex");
    }
    throw err;
  }
}
