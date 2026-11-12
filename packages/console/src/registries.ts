import type { RegistryAuth } from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { normalizeRegistry } from "./image-ref.js";
import type { RegistryCredentials } from "./registry.js";
import { registriesOf } from "./registry-use.js";
import type { SecretBox } from "./secretbox.js";

export interface RegistryView {
  registry: string;
  username: string | null;
  hasPassword: boolean;
  /** Un compte de lecture seule existe (registre privé géré par la console). */
  separated: boolean;
  insecure: boolean;
}

/**
 * Identifiants des registres d'images (publics ou privés). Le mot de passe est
 * chiffré avec la clé maître de la console ; il n'est jamais renvoyé par
 * l'API, ni écrit dans Git ni dans les journaux.
 */
export class RegistryStore {
  constructor(
    private readonly pool: Pool,
    private readonly box: SecretBox,
  ) {}

  async credentials(registry: string): Promise<RegistryCredentials | null> {
    const { rows } = await this.pool.query<{ username: string | null; password_enc: string | null; insecure: boolean }>(
      "SELECT username, password_enc, insecure FROM registry_credentials WHERE registry = $1",
      [registry],
    );
    const r = rows[0];
    if (!r) return null;
    let password: string | null = null;
    if (r.password_enc) {
      try {
        password = this.box.open(r.password_enc);
      } catch {
        password = null; // clé maître modifiée : le mot de passe est à ressaisir
      }
    }
    return { username: r.username, password, insecure: r.insecure };
  }

  /** Compte de lecture seule d'un registre (registre privé géré par la console), ou null. */
  async pullCredentials(registry: string): Promise<{ username: string; password: string } | null> {
    const { rows } = await this.pool.query<{ pull_username: string | null; pull_password_enc: string | null }>(
      "SELECT pull_username, pull_password_enc FROM registry_credentials WHERE registry = $1",
      [registry],
    );
    const r = rows[0];
    if (!r?.pull_username || !r.pull_password_enc) return null;
    try {
      return { username: r.pull_username, password: this.box.open(r.pull_password_enc) };
    } catch {
      return null; // clé maître modifiée : le compte est à régénérer
    }
  }

  /** Enregistre le compte de lecture seule (le registre doit déjà avoir ses identifiants de publication). */
  async setPull(registry: string, input: { username: string; password: string }): Promise<void> {
    const res = await this.pool.query("UPDATE registry_credentials SET pull_username = $2, pull_password_enc = $3, updated_at = now() WHERE registry = $1", [registry, input.username, this.box.seal(input.password)]);
    if ((res.rowCount ?? 0) === 0) throw new HttpError(404, "registry_not_found", "Registre introuvable.");
  }

  /**
   * Identifiants à transmettre à l'agent pour télécharger ces images : uniquement ceux des registres utilisés
   * (déduits des références, ou cités littéralement dans les textes fournis) et seulement s'ils sont complets. Pour un
   * registre qui a un compte de lecture seule, c'est celui-là qui est transmis : le compte de publication ne quitte pas
   * la console, hors correctif.
   */
  async authsFor(refs: string[], texts: string[] = []): Promise<RegistryAuth[]> {
    const used = registriesOf(refs);
    const { rows } = await this.pool.query<{ registry: string }>("SELECT registry FROM registry_credentials WHERE username IS NOT NULL AND password_enc IS NOT NULL ORDER BY registry");
    const out: RegistryAuth[] = [];
    for (const { registry } of rows) {
      if (!used.has(registry) && !(registry !== "docker.io" && texts.some((t) => t.includes(registry)))) continue;
      const pull = await this.pullCredentials(registry);
      if (pull) {
        out.push({ registry, username: pull.username, password: pull.password });
        continue;
      }
      const c = await this.credentials(registry);
      if (c?.username && c.password) out.push({ registry, username: c.username, password: c.password });
    }
    return out;
  }

  async list(): Promise<RegistryView[]> {
    const { rows } = await this.pool.query<{ registry: string; username: string | null; password_enc: string | null; pull_password_enc: string | null; insecure: boolean }>(
      "SELECT registry, username, password_enc, pull_password_enc, insecure FROM registry_credentials ORDER BY registry",
    );
    return rows.map((r) => ({ registry: r.registry, username: r.username, hasPassword: r.password_enc !== null, separated: r.pull_password_enc !== null, insecure: r.insecure }));
  }

  async upsert(rawRegistry: string, input: { username?: string | null; password?: string | null; insecure: boolean }, actor: string): Promise<RegistryView> {
    const registry = normalizeRegistry(rawRegistry);
    if (!registry) throw new HttpError(400, "invalid_registry", "Nom de registre invalide (ex. ghcr.io, registre.exemple.org:5000).");
    const username = input.username?.trim() || null;
    if (username && (username.length > 255 || /[\s:\p{Cc}]/u.test(username))) {
      throw new HttpError(400, "invalid_username", "Identifiant invalide (sans espace ni « : »).");
    }
    if (input.password && (input.password.length > 1024 || /\p{Cc}/u.test(input.password))) {
      throw new HttpError(400, "invalid_password", "Mot de passe ou jeton invalide.");
    }
    const existing = await this.pool.query<{ password_enc: string | null; pull_password_enc: string | null }>("SELECT password_enc, pull_password_enc FROM registry_credentials WHERE registry = $1", [registry]);
    // Un mot de passe absent de la requête conserve l'existant (jamais renvoyé par l'API).
    const passwordEnc = input.password ? this.box.seal(input.password) : (existing.rows[0]?.password_enc ?? null);
    if (username && !passwordEnc) throw new HttpError(400, "invalid_password", "Un mot de passe ou jeton est requis avec l'identifiant.");
    if (!username && input.password) throw new HttpError(400, "invalid_username", "Un identifiant est requis avec le mot de passe.");
    await this.pool.query(
      `INSERT INTO registry_credentials (registry, username, password_enc, insecure) VALUES ($1, $2, $3, $4)
       ON CONFLICT (registry) DO UPDATE SET username = $2, password_enc = $3, insecure = $4, updated_at = now()`,
      [registry, username, username ? passwordEnc : null, input.insecure],
    );
    await audit(this.pool, actor, "registry.configure", registry, "success");
    return { registry, username, hasPassword: username !== null && passwordEnc !== null, separated: existing.rows[0]?.pull_password_enc != null, insecure: input.insecure };
  }

  async remove(rawRegistry: string, actor: string): Promise<void> {
    const registry = normalizeRegistry(rawRegistry);
    const res = registry ? await this.pool.query("DELETE FROM registry_credentials WHERE registry = $1", [registry]) : null;
    if (!res || (res.rowCount ?? 0) === 0) throw new HttpError(404, "registry_not_found", "Registre introuvable.");
    await audit(this.pool, actor, "registry.remove", registry, "success");
  }
}
