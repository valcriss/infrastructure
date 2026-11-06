import { argon2, createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Paramètres Argon2id (recommandation OWASP : m=19 MiB, t=2, p=1).
const MEMORY_KIB = 19456;
const PASSES = 2;
const PARALLELISM = 1;
const TAG_LENGTH = 32;

function derive(password: string, salt: Buffer, m: number, t: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: password,
        nonce: salt,
        parallelism: p,
        tagLength: TAG_LENGTH,
        memory: m,
        passes: t,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hash au format `$argon2id$m=..,t=..,p=..$sel$empreinte` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, MEMORY_KIB, PASSES, PARALLELISM);
  return `$argon2id$m=${MEMORY_KIB},t=${PASSES},p=${PARALLELISM}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  // ["", "argon2id", "m=..,t=..,p=..", sel, empreinte]
  if (parts.length !== 5 || parts[1] !== "argon2id") return false;
  const params = Object.fromEntries(
    (parts[2] ?? "").split(",").map((kv) => kv.split("=") as [string, string]),
  );
  const m = Number(params.m);
  const t = Number(params.t);
  const p = Number(params.p);
  if (![m, t, p].every(Number.isInteger)) return false;
  const salt = Buffer.from(parts[3] ?? "", "base64url");
  const expected = Buffer.from(parts[4] ?? "", "base64url");
  const actual = await derive(password, salt, m, t, p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Jeton aléatoire opaque (256 bits), à ne montrer qu'une seule fois. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Empreinte SHA-256 hexadécimale ; suffisante pour des jetons à forte entropie. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
