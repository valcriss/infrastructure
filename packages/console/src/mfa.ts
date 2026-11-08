import { createHmac, randomBytes } from "node:crypto";
import { randomToken, sha256 } from "./crypto.js";
import type { Pool } from "./db.js";

// --- TOTP (RFC 6238 : HMAC-SHA1, 30 s, 6 chiffres) ---------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SEC = 30;

export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("secret TOTP invalide");
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Code à 6 chiffres pour un pas de temps (compteur) donné. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = (((mac[offset] ?? 0) & 0x7f) << 24) | (((mac[offset + 1] ?? 0) & 0xff) << 16) | (((mac[offset + 2] ?? 0) & 0xff) << 8) | ((mac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Pas de temps dont le code correspond (tolérance ± 1 pas pour la dérive d'horloge), ou null. */
export function matchTotp(secret: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
  for (const step of [current, current - 1, current + 1]) {
    if (totpCode(secret, step) === code) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, email: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD_SEC}`;
}

/** Accepte le code seulement s'il est plus récent que le dernier utilisé (pas de rejeu). */
export async function consumeTotp(pool: Pool, userId: string, secret: string, code: string): Promise<boolean> {
  const step = matchTotp(secret, code);
  if (step === null) return false;
  const res = await pool.query("UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)", [userId, step]);
  return (res.rowCount ?? 0) > 0;
}

// --- Codes de secours -----------------------------------------------------------------------------------

const RECOVERY_COUNT = 10;
const normalize = (code: string): string => code.replace(/[\s-]/g, "").toLowerCase();

/** Remplace les codes de secours de l'utilisateur ; les codes en clair ne sont montrés qu'ici. */
export async function regenerateRecoveryCodes(pool: Pool, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await pool.query("DELETE FROM recovery_codes WHERE user_id = $1", [userId]);
  for (const c of codes) await pool.query("INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, sha256(normalize(c))]);
  return codes;
}

export async function consumeRecoveryCode(pool: Pool, userId: string, code: string): Promise<boolean> {
  const res = await pool.query("UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL", [userId, sha256(normalize(code))]);
  return (res.rowCount ?? 0) > 0;
}

// --- Défis WebAuthn (en mémoire, courte durée) ----------------------------------------------------------

interface Challenge {
  challenge: string;
  purpose: string;
  userId: string | null;
  expiresAt: number;
}

/** Défis à usage unique, 5 minutes. Un seul processus console : la mémoire suffit. */
export class ChallengeStore {
  private readonly items = new Map<string, Challenge>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  put(challenge: string, purpose: string, userId: string | null): string {
    const now = this.now();
    for (const [k, v] of this.items) if (v.expiresAt < now) this.items.delete(k);
    const id = randomToken(16);
    this.items.set(id, { challenge, purpose, userId, expiresAt: now + this.ttlMs });
    return id;
  }

  /** Retire le défi (usage unique) et le renvoie s'il est valide pour cet usage. */
  take(id: string, purpose: string): Challenge | null {
    const c = this.items.get(id);
    this.items.delete(id);
    return c && c.purpose === purpose && c.expiresAt >= this.now() ? c : null;
  }
}
