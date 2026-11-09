import { identityToRecipient } from "age-encryption";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  BackupFormatError,
  InvalidKeyError,
  KeyRequiredError,
  MANAGED_PATHS,
  SecretEncryptor,
  buildSnapshot,
  isAllowedBackupPath,
  parseSnapshot,
  readWorkTree,
  type CacheEntry,
  type PolicySpec,
  type ParsedBackup,
  type SnapshotInput,
} from "./backup-format.js";
import { audit, type Pool } from "./db.js";
import { GitError, gitErrorToHttp, validateBranch, validateRepoUrl, type GitCredentials, type GitRunner } from "./git.js";
import { HttpError } from "./http-error.js";
import type { SecretBox } from "./secretbox.js";
import { digestOf, getRevision, bumpConfigRevision } from "./stacks.js";
import type { BackupStatusProvider } from "./stack-routes.js";

/** Codes d'erreur qui bloquent la synchronisation jusqu'à une action explicite. */
const BLOCKING = new Set(["diverged", "foreign_installation", "remote_not_empty", "no_recipient", "token_unreadable"]);
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const PREVIEW_TTL_MS = 10 * 60_000;

export interface BackupLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface BackupDeps {
  pool: Pool;
  box: SecretBox;
  git: GitRunner;
  dataDir: string;
  log: BackupLogger;
  /** Validation de l'URL du dépôt (HTTPS uniquement par défaut ; assouplie dans les tests). */
  validateUrl?: (url: string) => string;
  /** Période de la boucle de synchronisation et délai de regroupement des changements. */
  tickMs?: number;
  debounceMs?: number;
}

export interface BackupConfigInput {
  url: string;
  username: string;
  token?: string;
  branch: string;
}

interface SettingsRow {
  repo_url: string;
  username: string;
  token_enc: string;
  branch: string;
  enabled: boolean;
  covered_revision: string;
  pushed_revision: string;
  local_commit: string | null;
  pushed_commit: string | null;
  last_push_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: Date | null;
  retry_count: number;
  next_retry_at: Date | null;
}

export type BackupState = "not_configured" | "disabled" | "ok" | "pending" | "error" | "blocked";

export interface BackupStatus {
  state: BackupState;
  configured: boolean;
  enabled: boolean;
  repoUrl: string | null;
  username: string | null;
  branch: string | null;
  /** Compteur de changements de configuration, et dernier compteur poussé avec succès. */
  configRevision: number;
  pushedRevision: number;
  pendingRevisions: number;
  localCommit: string | null;
  pushedCommit: string | null;
  lastPushAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  nextRetryAt: string | null;
  hasRestorationKey: boolean;
  installationId: string;
}

export type RemoteState = "empty" | "branch_missing" | "has_backup" | "foreign_content";

export interface ConnectionTest {
  remote: RemoteState;
  /** Présent si le dépôt contient une sauvegarde. */
  backup: { installationId: string; configRevision: number; formatVersion: number; sameInstallation: boolean } | null;
}

export interface RestorePreview {
  previewId: string;
  expiresAt: string;
  installationId: string;
  configRevision: number;
  hasSecrets: boolean;
  /** La clé de restauration de cette console sera remplacée par celle du dépôt. */
  restorationKeyWillChange: boolean;
  stacks: {
    id: string;
    name: string;
    hostId: string;
    description: string;
    variables: number;
    files: number;
    conflict: "none" | "same_id" | "same_name";
  }[];
  backupHosts: { id: string; name: string }[];
  availableHosts: { id: string; name: string; presence: "online" | "offline" }[];
}

interface StoredPreview {
  parsed: ParsedBackup;
  commit: string;
  recipient: string | null;
  expires: number;
}

const nowMs = (): number => Date.now();

export class BackupService implements BackupStatusProvider {
  private readonly validateUrl: (url: string) => string;
  private readonly workDir: string;
  private readonly previews = new Map<string, StoredPreview>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: BackupDeps) {
    this.validateUrl = deps.validateUrl ?? ((u) => validateRepoUrl(u));
    this.workDir = join(deps.dataDir, "git", "work");
  }

  // --- Cycle de vie -------------------------------------------------------------

  async start(): Promise<void> {
    await this.deps.git.init();
    this.timer = setInterval(() => void this.tick().catch((e: unknown) => this.deps.log.error(e, "boucle de sauvegarde")), this.deps.tickMs ?? 5000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Attend la fin de la synchronisation en cours (tests, arrêt propre). */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => {});
  }

  // --- Statut ---------------------------------------------------------------------

  private async settings(): Promise<SettingsRow | null> {
    const { rows } = await this.deps.pool.query<SettingsRow>("SELECT * FROM backup_settings");
    return rows[0] ?? null;
  }

  private async configState(): Promise<{ revision: number; installationId: string; updatedAt: Date }> {
    const { rows } = await this.deps.pool.query<{ config_revision: string; installation_id: string; updated_at: Date }>(
      "SELECT config_revision, installation_id, updated_at FROM config_state",
    );
    const r = rows[0];
    if (!r) throw new Error("état de configuration absent");
    return { revision: Number(r.config_revision), installationId: r.installation_id, updatedAt: r.updated_at };
  }

  private async recipient(): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ restoration_recipient: string | null }>("SELECT restoration_recipient FROM admin");
    return rows[0]?.restoration_recipient ?? null;
  }

  async changeStatus(): Promise<"not_configured" | "pending"> {
    const s = await this.settings();
    return s?.enabled ? "pending" : "not_configured";
  }

  async status(): Promise<BackupStatus> {
    const [s, cs, recipient] = await Promise.all([this.settings(), this.configState(), this.recipient()]);
    const pushed = Number(s?.pushed_revision ?? 0);
    const pending = s ? pushed < cs.revision || s.local_commit !== s.pushed_commit : false;
    let state: BackupState = "ok";
    if (!s) state = "not_configured";
    else if (!s.enabled) state = "disabled";
    else if (s.last_error_code) state = BLOCKING.has(s.last_error_code) ? "blocked" : "error";
    else if (pending) state = "pending";
    return {
      state,
      configured: s !== null,
      enabled: s?.enabled ?? false,
      repoUrl: s?.repo_url ?? null,
      username: s?.username ?? null,
      branch: s?.branch ?? null,
      configRevision: cs.revision,
      pushedRevision: pushed,
      pendingRevisions: Math.max(0, cs.revision - pushed),
      localCommit: s?.local_commit ?? null,
      pushedCommit: s?.pushed_commit ?? null,
      lastPushAt: s?.last_push_at?.toISOString() ?? null,
      lastError: s?.last_error_code
        ? { code: s.last_error_code, message: s.last_error_message ?? "", at: s.last_error_at?.toISOString() ?? "" }
        : null,
      nextRetryAt: s?.next_retry_at?.toISOString() ?? null,
      hasRestorationKey: recipient !== null,
      installationId: cs.installationId,
    };
  }

  // --- Configuration ----------------------------------------------------------------

  private validateIdentity(username: string, token: string | undefined): void {
    if (!/^[^\s:]{1,128}$/.test(username)) {
      throw new HttpError(400, "invalid_git_username", "Identifiant Git invalide (sans espace ni « : »).");
    }
    if (token !== undefined && (token.length < 1 || token.length > 512 || /[\s\p{Cc}]/u.test(token))) {
      throw new HttpError(400, "invalid_git_token", "Jeton Git invalide.");
    }
  }

  async saveConfig(input: BackupConfigInput, actor: string): Promise<BackupStatus> {
    const url = this.validateUrl(input.url);
    const branch = validateBranch(input.branch);
    this.validateIdentity(input.username, input.token);
    const existing = await this.settings();
    if (!existing && !input.token) throw new HttpError(400, "invalid_git_token", "Le jeton Git est requis.");
    const tokenEnc = input.token ? this.deps.box.seal(input.token) : (existing as SettingsRow).token_enc;
    const target = existing && (existing.repo_url !== url || existing.branch !== branch) ? "reset" : existing ? "keep" : "reset";

    await this.deps.pool.query(
      `INSERT INTO backup_settings (repo_url, username, token_enc, branch, enabled)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (singleton) DO UPDATE SET repo_url = $1, username = $2, token_enc = $3, branch = $4,
         enabled = true, updated_at = now()`,
      [url, input.username, tokenEnc, branch],
    );
    if (target === "reset") {
      // Autre dépôt ou autre branche : l'état de synchronisation ne s'applique plus.
      await this.deps.pool.query(
        `UPDATE backup_settings SET covered_revision = 0, pushed_revision = 0, local_commit = NULL, pushed_commit = NULL,
           last_push_at = NULL, last_error_code = NULL, last_error_message = NULL, last_error_at = NULL,
           retry_count = 0, next_retry_at = NULL`,
      );
      await rm(this.workDir, { recursive: true, force: true });
    } else {
      // Nouveaux identifiants : on retente immédiatement.
      await this.deps.pool.query(
        "UPDATE backup_settings SET last_error_code = NULL, last_error_message = NULL, last_error_at = NULL, retry_count = 0, next_retry_at = NULL",
      );
    }
    await bumpConfigRevision(this.deps.pool);
    await audit(this.deps.pool, actor, "backup.configure", null, "success");
    return this.status();
  }

  async removeConfig(actor: string): Promise<void> {
    await this.idle();
    await this.deps.pool.query("DELETE FROM backup_settings");
    await this.deps.pool.query("DELETE FROM backup_secret_cache");
    await rm(this.workDir, { recursive: true, force: true });
    await audit(this.deps.pool, actor, "backup.remove", null, "success");
  }

  // --- Test de connexion ---------------------------------------------------------------

  async testConnection(input: { url: string; username: string; token?: string; branch: string }): Promise<ConnectionTest> {
    const url = this.validateUrl(input.url);
    const branch = validateBranch(input.branch);
    this.validateIdentity(input.username, input.token);
    let token = input.token;
    if (!token) {
      const s = await this.settings();
      if (!s) throw new HttpError(400, "invalid_git_token", "Le jeton Git est requis.");
      token = this.deps.box.open(s.token_enc);
    }
    const creds: GitCredentials = { username: input.username, token };
    const { git } = this.deps;
    const tmp = await mkdtemp(join(this.deps.dataDir, "git", "test-"));
    try {
      const heads = await git.run(["ls-remote", "--heads", "--", url], { creds, remoteUrl: url, timeoutMs: 60_000 });
      const names = heads.stdout.split("\n").flatMap((l) => (l.split("\t")[1]?.replace("refs/heads/", "") ? [l.split("\t")[1]!.replace("refs/heads/", "")] : []));
      if (names.length === 0) return { remote: "empty", backup: null };
      if (!names.includes(branch)) return { remote: "branch_missing", backup: null };

      await git.run(["clone", "--depth", "1", "--single-branch", "--branch", branch, "--", url, tmp], { creds, remoteUrl: url, timeoutMs: 120_000 });
      const files = await readWorkTree(tmp);
      const manifest = files.get("manifest.yaml");
      if (!manifest) return { remote: "foreign_content", backup: null };
      const { parse } = await import("yaml");
      const m = parse(manifest, { maxAliasCount: 0 }) as { installationId?: string; configRevision?: number; formatVersion?: number };
      const cs = await this.configState();
      return {
        remote: "has_backup",
        backup: {
          installationId: String(m.installationId ?? ""),
          configRevision: Number(m.configRevision ?? 0),
          formatVersion: Number(m.formatVersion ?? 0),
          sameInstallation: m.installationId === cs.installationId,
        },
      };
    } catch (err) {
      if (err instanceof GitError) throw gitErrorToHttp(err);
      if (err instanceof BackupFormatError) throw new HttpError(422, "invalid_backup", err.message);
      throw err;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // --- Synchronisation --------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.running) return;
    const s = await this.settings();
    if (!s || !s.enabled) return;
    if (s.last_error_code && BLOCKING.has(s.last_error_code)) return; // action explicite requise
    const cs = await this.configState();
    const unpushed = s.local_commit !== s.pushed_commit;
    if (!(Number(s.pushed_revision) < cs.revision) && !unpushed) return;
    if (s.next_retry_at && s.next_retry_at.getTime() > nowMs()) return;
    // Regroupe les changements rapprochés (sauf reprise d'un commit local déjà prêt).
    if (!unpushed && nowMs() - cs.updatedAt.getTime() < (this.deps.debounceMs ?? 5000)) return;
    await this.sync();
  }

  /** Lance une synchronisation (ignorée si une autre est déjà en cours). */
  sync(): Promise<void> {
    if (this.running) return this.running;
    const p = this.runSync()
      .catch((err: unknown) => this.deps.log.error(err, "synchronisation de la sauvegarde"))
      .finally(() => {
        this.running = null;
      });
    this.running = p;
    return p;
  }

  /** Action manuelle : lève le blocage et le délai d'attente, puis synchronise. */
  async syncNow(actor: string): Promise<void> {
    await this.deps.pool.query("UPDATE backup_settings SET last_error_code = NULL, last_error_message = NULL, next_retry_at = NULL");
    await audit(this.deps.pool, actor, "backup.sync", null, "success");
    await this.sync();
  }

  private async fail(code: string, message: string): Promise<void> {
    const blocked = BLOCKING.has(code);
    await this.deps.pool.query(
      `UPDATE backup_settings SET last_error_code = $1, last_error_message = $2, last_error_at = now(),
         retry_count = retry_count + 1,
         next_retry_at = CASE WHEN $3 THEN NULL
           ELSE now() + make_interval(secs => LEAST($4::float8, $5::float8 * power(2, LEAST(retry_count, 10)) / 1000.0)) END`,
      [code, message.slice(0, 500), blocked, BACKOFF_MAX_MS / 1000, BACKOFF_BASE_MS],
    );
    this.deps.log.warn(`sauvegarde Git : ${code} — ${message}`);
  }

  private async revParse(cwd: string, ref: string): Promise<string | null> {
    const r = await this.deps.git.run(["rev-parse", "--verify", "-q", ref], { cwd, allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async collectSnapshot(): Promise<SnapshotInput> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const cs = await client.query<{ config_revision: string; installation_id: string }>("SELECT config_revision, installation_id FROM config_state");
      const hosts = await client.query<{ id: string; name: string }>("SELECT id, name FROM hosts WHERE revoked_at IS NULL ORDER BY id");
      const stacks = await client.query<{ id: string; name: string; host_id: string; description: string; current_revision: number }>(
        "SELECT id, name, host_id, description, current_revision FROM stacks ORDER BY id",
      );
      const out: SnapshotInput = {
        installationId: cs.rows[0]?.installation_id ?? "",
        configRevision: Number(cs.rows[0]?.config_revision ?? 0),
        hosts: hosts.rows,
        stacks: [],
      };
      const policyRows = await client.query<{ stack_id: string; service: string; policy: string; pattern: string | null }>(
        "SELECT stack_id, service, policy, pattern FROM image_policies",
      );
      for (const s of stacks.rows) {
        const rev = await getRevision(client, s.id, s.current_revision);
        if (!rev) throw new Error(`révision courante introuvable pour ${s.id}`);
        out.stacks.push({
          id: s.id,
          name: s.name,
          hostId: s.host_id,
          description: s.description,
          revision: rev.revision,
          content: {
            compose: rev.compose,
            variables: rev.variables,
            files: rev.files,
            sensitiveFiles: rev.sensitiveFiles,
            composeSensitive: rev.composeSensitive,
          },
          updatePolicies: Object.fromEntries(
            policyRows.rows.filter((p) => p.stack_id === s.id).map((p) => [p.service, { policy: p.policy as PolicySpec["policy"], pattern: p.pattern }]),
          ),
        });
      }
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async writeSnapshot(files: Map<string, string>): Promise<void> {
    const root = resolve(this.workDir);
    for (const top of MANAGED_PATHS) await rm(join(root, top), { recursive: true, force: true });
    for (const [path, text] of files) {
      // Défense en profondeur : seuls des chemins du format, confinés au dépôt, sont écrits.
      const abs = resolve(root, path);
      if (!isAllowedBackupPath(path) || !abs.startsWith(root + sep)) throw new Error(`chemin de sauvegarde refusé : ${path}`);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text);
    }
  }

  private async runSync(): Promise<void> {
    const { pool, git } = this.deps;
    const s = await this.settings();
    if (!s || !s.enabled) return;
    const recipient = await this.recipient();
    if (!recipient) {
      return this.fail("no_recipient", "Aucune clé de restauration : générez-la avant d'activer la sauvegarde.");
    }
    let creds: GitCredentials;
    try {
      creds = { username: s.username, token: this.deps.box.open(s.token_enc) };
    } catch {
      return this.fail("token_unreadable", "Le jeton Git n'est plus lisible (clé maître modifiée) : saisissez-le à nouveau.");
    }
    const branch = s.branch;

    try {
      // 1. Dépôt de travail local, branché sur le dépôt distant configuré.
      await mkdir(this.workDir, { recursive: true });
      const hasRepo = await stat(join(this.workDir, ".git")).then(() => true, () => false);
      if (!hasRepo) await git.run(["init", "-q", "-b", branch], { cwd: this.workDir });
      const remotes = (await git.run(["remote"], { cwd: this.workDir })).stdout.split("\n");
      if (remotes.includes("origin")) await git.run(["remote", "set-url", "origin", "--", s.repo_url], { cwd: this.workDir });
      else await git.run(["remote", "add", "origin", "--", s.repo_url], { cwd: this.workDir });

      await git.run(["fetch", "--prune", "origin"], { cwd: this.workDir, creds, remoteUrl: s.repo_url });
      const remoteTip = await this.revParse(this.workDir, `refs/remotes/origin/${branch}`);
      let localHead = await this.revParse(this.workDir, "HEAD");

      // 2. Jamais d'écrasement : le distant doit être un ancêtre de notre historique.
      if (remoteTip) {
        const ancestor = localHead
          ? (await git.run(["merge-base", "--is-ancestor", remoteTip, localHead], { cwd: this.workDir, allowFail: true })).code === 0
          : false;
        if (!ancestor) {
          if (localHead) {
            return this.fail("diverged", "Le dépôt distant a évolué depuis la dernière sauvegarde : synchronisation bloquée (aucun écrasement). Résolvez la divergence puis relancez.");
          }
          if (s.pushed_commit !== remoteTip) {
            return this.fail("remote_not_empty", "Le dépôt contient déjà des commits qui ne proviennent pas de cette installation : restaurez-le depuis l'assistant ou utilisez un dépôt vide.");
          }
        }
        // Le manifeste du dépôt doit porter l'identifiant de cette installation.
        const manifest = await git.run(["show", `${remoteTip}:manifest.yaml`], { cwd: this.workDir, allowFail: true });
        const cs = await this.configState();
        if (manifest.code !== 0 || !new RegExp(`installationId:\\s*['"]?${cs.installationId}['"]?\\s*$`, "m").test(manifest.stdout)) {
          return this.fail("foreign_installation", "Le dépôt appartient à une autre installation de la console : synchronisation bloquée.");
        }
        if (!localHead) {
          await git.run(["checkout", "-q", "-B", branch, remoteTip], { cwd: this.workDir });
          localHead = remoteTip;
        }
      }
      if (localHead) await git.run(["reset", "-q", "--hard", "HEAD"], { cwd: this.workDir });

      // 3. Export cohérent de la configuration.
      const snapshot = await this.collectSnapshot();
      const cache = new Map<string, CacheEntry>();
      for (const r of (await pool.query<{ path: string; hmac: string; ciphertext: string }>("SELECT path, hmac, ciphertext FROM backup_secret_cache")).rows) {
        cache.set(r.path, { hmac: r.hmac, ciphertext: r.ciphertext });
      }
      const enc = new SecretEncryptor(recipient, (v) => this.deps.box.hmac(v), cache);
      const files = await buildSnapshot(snapshot, enc);
      await this.writeSnapshot(files);

      // 4. Commit local s'il y a des changements.
      await git.run(["add", "-A"], { cwd: this.workDir });
      const dirty = (await git.run(["status", "--porcelain"], { cwd: this.workDir })).stdout.trim().length > 0;
      if (dirty) {
        await git.run(
          ["-c", "user.name=Console Docker", "-c", "user.email=console@localhost", "commit", "-q", "-m", `Sauvegarde de la configuration (révision ${snapshot.configRevision})`],
          { cwd: this.workDir },
        );
      }
      localHead = await this.revParse(this.workDir, "HEAD");
      await pool.query("UPDATE backup_settings SET local_commit = $1, covered_revision = $2", [localHead, snapshot.configRevision]);
      await pool.query("DELETE FROM backup_secret_cache");
      for (const [path, e] of enc.used) {
        await pool.query("INSERT INTO backup_secret_cache (path, hmac, ciphertext) VALUES ($1, $2, $3)", [path, e.hmac, e.ciphertext]);
      }

      // 5. Push (jamais forcé). Le succès du commit local ne vaut pas sauvegarde distante.
      if (localHead && localHead !== remoteTip) {
        await git.run(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: this.workDir, creds, remoteUrl: s.repo_url });
      }
      await pool.query(
        `UPDATE backup_settings SET pushed_commit = $1, local_commit = $1, pushed_revision = $2,
           last_push_at = CASE WHEN $3 THEN now() ELSE last_push_at END,
           last_error_code = NULL, last_error_message = NULL, last_error_at = NULL, retry_count = 0, next_retry_at = NULL`,
        [localHead, snapshot.configRevision, localHead !== remoteTip],
      );
    } catch (err) {
      if (err instanceof GitError) {
        if (err.code === "rejected") return this.fail("diverged", "Push refusé : le dépôt distant a évolué. Aucun écrasement n'est effectué.");
        const friendly = gitErrorToHttp(err);
        return this.fail(friendly.code, friendly.message);
      }
      return this.fail("internal", (err as Error).message);
    }
  }

  // --- Restauration -------------------------------------------------------------------------

  private async requireCredentials(): Promise<{ s: SettingsRow; creds: GitCredentials }> {
    const s = await this.settings();
    if (!s) throw new HttpError(409, "backup_not_configured", "Aucun dépôt de sauvegarde n'est configuré.");
    return { s, creds: { username: s.username, token: this.deps.box.open(s.token_enc) } };
  }

  /**
   * Récupère le dépôt dans un espace temporaire, vérifie format, chemins et
   * intégrité, déchiffre avec la clé fournie et décrit ce qui serait importé.
   * Rien n'est modifié.
   */
  async restorePreview(restorationKey: string | null): Promise<RestorePreview> {
    const { s, creds } = await this.requireCredentials();
    const tmp = await mkdtemp(join(this.deps.dataDir, "git", "restore-"));
    try {
      await this.deps.git.run(["clone", "--depth", "1", "--single-branch", "--branch", s.branch, "--", s.repo_url, tmp], { creds, remoteUrl: s.repo_url });
      const commit = (await this.deps.git.run(["rev-parse", "HEAD"], { cwd: tmp })).stdout.trim();
      const tree = await readWorkTree(tmp);
      if (!tree.has("manifest.yaml")) throw new HttpError(422, "no_backup", "Ce dépôt ne contient pas de sauvegarde de la console.");
      let parsed: ParsedBackup;
      try {
        parsed = await parseSnapshot(tree, restorationKey?.trim() || null);
      } catch (err) {
        if (err instanceof KeyRequiredError) throw new HttpError(400, "restoration_key_required", err.message);
        if (err instanceof InvalidKeyError) throw new HttpError(400, "invalid_restoration_key", err.message);
        if (err instanceof BackupFormatError) throw new HttpError(422, "invalid_backup", err.message);
        throw err;
      }
      const recipient = restorationKey?.trim() ? await identityToRecipient(restorationKey.trim()) : null;
      const current = await this.recipient();

      const stacks = await this.deps.pool.query<{ id: string; name: string }>("SELECT id, name FROM stacks");
      const byId = new Set(stacks.rows.map((r) => r.id));
      const byName = new Set(stacks.rows.map((r) => r.name));
      const hosts = await this.deps.pool.query<{ id: string; name: string }>("SELECT id, name FROM hosts WHERE revoked_at IS NULL ORDER BY created_at");

      const previewId = randomUUID();
      const expires = nowMs() + PREVIEW_TTL_MS;
      for (const [id, p] of this.previews) if (p.expires < nowMs()) this.previews.delete(id);
      this.previews.set(previewId, { parsed, commit, recipient, expires });

      return {
        previewId,
        expiresAt: new Date(expires).toISOString(),
        installationId: parsed.installationId,
        configRevision: parsed.configRevision,
        hasSecrets: parsed.hasSecrets,
        restorationKeyWillChange: recipient !== null && current !== null && recipient !== current,
        stacks: parsed.stacks.map((st) => ({
          id: st.id,
          name: st.name,
          hostId: st.hostId,
          description: st.description,
          variables: Object.keys(st.content.variables).length,
          files: Object.keys(st.content.files).length,
          conflict: byId.has(st.id) ? "same_id" : byName.has(st.name) ? "same_name" : "none",
        })),
        backupHosts: parsed.hosts,
        availableHosts: hosts.rows.map((h) => ({ ...h, presence: "offline" as const })),
      };
    } catch (err) {
      if (err instanceof GitError) throw gitErrorToHttp(err);
      if (err instanceof BackupFormatError) throw new HttpError(422, "invalid_backup", err.message);
      throw err;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Applique un aperçu : importe la configuration sans lancer ni arrêter de
   * conteneur. Les stacks en conflit ne sont remplacées que sur demande
   * explicite (nouvelle révision, jamais de suppression).
   */
  async restoreApply(
    input: { previewId: string; hostMapping: Record<string, string>; replaceStackIds: string[] },
    actor: string,
  ): Promise<{ created: number; replaced: number }> {
    const preview = this.previews.get(input.previewId);
    if (!preview || preview.expires < nowMs()) {
      throw new HttpError(410, "preview_expired", "L'aperçu de restauration a expiré : relancez l'analyse.");
    }
    const { parsed, commit, recipient } = preview;
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE stacks IN SHARE ROW EXCLUSIVE MODE");

      const hosts = (await client.query<{ id: string }>("SELECT id FROM hosts WHERE revoked_at IS NULL")).rows.map((h) => h.id);
      const resolveHost = (backupHostId: string): string | null => {
        const mapped = input.hostMapping[backupHostId];
        if (mapped) return hosts.includes(mapped) ? mapped : null;
        return hosts.length === 1 ? (hosts[0] as string) : null;
      };
      const missing = [...new Set(parsed.stacks.map((s) => s.hostId))].filter((h) => resolveHost(h) === null);
      if (missing.length > 0) {
        throw new HttpError(400, "host_mapping_required", "Associez chaque hôte de la sauvegarde à un hôte enrôlé.", { missing });
      }

      const existing = (await client.query<{ id: string; name: string }>("SELECT id, name FROM stacks")).rows;
      const conflicts = parsed.stacks.flatMap((st): { id: string; name: string; reason: "same_id" | "same_name" }[] => {
        const sameId = existing.find((e) => e.id === st.id);
        const sameName = existing.find((e) => e.name === st.name && e.id !== st.id);
        if (sameName) return [{ id: st.id, name: st.name, reason: "same_name" as const }];
        if (sameId && !input.replaceStackIds.includes(st.id)) return [{ id: st.id, name: st.name, reason: "same_id" as const }];
        return [];
      });
      if (conflicts.length > 0) {
        throw new HttpError(409, "restore_conflicts", "Des stacks existent déjà : choisissez explicitement celles à remplacer.", { conflicts });
      }

      let created = 0;
      let replaced = 0;
      for (const st of parsed.stacks) {
        const c = st.content;
        const message = `Restauré depuis Git (révision ${st.sourceRevision} d'origine)`;
        const args = [JSON.stringify(c.variables), JSON.stringify(c.files), JSON.stringify(c.sensitiveFiles), c.composeSensitive, digestOf(c)];
        if (existing.some((e) => e.id === st.id)) {
          const cur = (await client.query<{ current_revision: number }>("SELECT current_revision FROM stacks WHERE id = $1 FOR UPDATE", [st.id])).rows[0];
          const next = (cur?.current_revision ?? 0) + 1;
          await client.query(
            `INSERT INTO stack_revisions (stack_id, revision, compose, variables, files, sensitive_files, compose_sensitive, digest, author, message)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [st.id, next, c.compose, ...args, actor, message],
          );
          await client.query("UPDATE stacks SET current_revision = $2, description = $3, updated_at = now() WHERE id = $1", [st.id, next, st.description]);
          replaced++;
        } else {
          const hostId = resolveHost(st.hostId) as string;
          // adopt_pending : des conteneurs du même projet peuvent déjà tourner sur l'hôte
          // (ancienne installation) ; le premier déploiement pourra les reprendre explicitement.
          await client.query(
            "INSERT INTO stacks (id, name, host_id, description, current_revision, adopt_pending) VALUES ($1, $2, $3, $4, 1, true)",
            [st.id, st.name, hostId, st.description],
          );
          await client.query(
            `INSERT INTO stack_revisions (stack_id, revision, compose, variables, files, sensitive_files, compose_sensitive, digest, author, message)
             VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [st.id, c.compose, ...args, actor, message],
          );
          created++;
        }
        // Règles de suivi des versions : restaurées avec la stack (remplacent celles du même service).
        for (const [service, p] of Object.entries(st.updatePolicies)) {
          await client.query(
            `INSERT INTO image_policies (stack_id, service, policy, pattern) VALUES ($1, $2, $3, $4)
             ON CONFLICT (stack_id, service) DO UPDATE SET policy = $3, pattern = $4, updated_at = now()`,
            [st.id, service, p.policy, p.pattern],
          );
        }
      }

      // On poursuit l'installation d'origine : même identifiant et même clé de restauration.
      await client.query("UPDATE config_state SET installation_id = $1", [parsed.installationId]);
      await bumpConfigRevision(client);
      if (recipient) await client.query("UPDATE admin SET restoration_recipient = $1", [recipient]);
      const rev = Number((await client.query<{ config_revision: string }>("SELECT config_revision FROM config_state")).rows[0]?.config_revision ?? 0);
      await client.query(
        `UPDATE backup_settings SET covered_revision = $2, pushed_revision = $2, local_commit = $1, pushed_commit = $1,
           last_error_code = NULL, last_error_message = NULL, last_error_at = NULL, retry_count = 0, next_retry_at = NULL`,
        [commit, rev],
      );
      await audit(client, actor, "backup.restore", parsed.installationId, "success");
      await client.query("COMMIT");
      this.previews.delete(input.previewId);
      // L'état de synchronisation change : le dépôt de travail sera rattaché au commit restauré.
      await rm(this.workDir, { recursive: true, force: true });
      return { created, replaced };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
