import { redact } from "@infra/shared";
import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./http-error.js";
import { skipsTlsVerification } from "./tls-policy.js";

export interface GitCredentials {
  username: string;
  token: string;
}

export type GitErrorCode = "auth" | "network" | "tls" | "not_found" | "rejected" | "unknown";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: GitErrorCode,
  ) {
    super(message);
  }
}

/** Classe une erreur Git d'après sa sortie (exécutée avec LC_ALL=C : messages anglais). */
export function classifyGitError(stderr: string): GitErrorCode {
  const s = stderr.toLowerCase();
  if (/ssl certificate|certificate verify|self.signed|unable to get local issuer|tls/.test(s)) return "tls";
  if (/authentication failed|could not read username|could not read password|invalid username or password|http (401|403)|returned error: (401|403)|access denied|permission denied/.test(s)) return "auth";
  if (/non-fast-forward|\[rejected\]|fetch first|failed to push some refs|updates were rejected/.test(s)) return "rejected";
  if (/repository .* not found|not found|returned error: 404|does not appear to be a git repository|http 404/.test(s)) return "not_found";
  if (/could not resolve host|failed to connect|connection (refused|timed out|reset)|timed out|unable to access|network is unreachable|early eof|the remote end hung up/.test(s)) return "network";
  return "unknown";
}

export interface GitRunnerOptions {
  dataDir: string;
  /** Tests uniquement : autorise file:// et http:// (jamais exposé par l'API). */
  allowInsecureProtocols?: boolean;
  /** Autorité de certification supplémentaire (serveur Git interne). */
  caFile?: string | null;
  tlsSkipVerifyHosts?: readonly string[];
}

export interface GitRunOptions {
  cwd?: string;
  creds?: GitCredentials;
  timeoutMs?: number;
  /** URL effective du serveur pour les commandes réseau, y compris via origin. */
  remoteUrl?: string;
  /** Retourne le résultat au lieu de lever une erreur quand le code de sortie est non nul. */
  allowFail?: boolean;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Exécute la CLI `git` avec des arguments structurés (jamais de shell). Le
 * jeton est transmis par l'environnement du processus fils via GIT_ASKPASS :
 * il n'apparaît ni dans les arguments, ni dans une URL, ni dans `.git/config`.
 * Seul HTTPS est autorisé (sauf mode test), les assistants d'identifiants et
 * la configuration globale ou système sont désactivés.
 */
export class GitRunner {
  private readonly home: string;
  private readonly askpass: string;
  private readonly hooks: string;

  constructor(private readonly opts: GitRunnerOptions) {
    const base = join(opts.dataDir, "git");
    this.home = join(base, "home");
    this.askpass = join(base, "askpass.sh");
    this.hooks = join(base, "no-hooks");
  }

  async init(): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await mkdir(this.hooks, { recursive: true, mode: 0o700 });
    await writeFile(join(this.home, "gitconfig"), "");
    await writeFile(
      this.askpass,
      `#!/bin/sh\ncase "$1" in\n  *sername*) printf '%s\\n' "$GIT_USER" ;;\n  *) printf '%s\\n' "$GIT_TOKEN" ;;\nesac\n`,
      { mode: 0o700 },
    );
    await chmod(this.askpass, 0o700);
  }

  private env(creds?: GitCredentials): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: this.home,
      XDG_CONFIG_HOME: this.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(this.home, "gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: this.askpass,
      LC_ALL: "C",
    };
    for (const k of ["SYSTEMROOT", "TEMP", "TMP", "TMPDIR"]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    if (this.opts.caFile) env.GIT_SSL_CAINFO = this.opts.caFile;
    if (creds) {
      env.GIT_USER = creds.username;
      env.GIT_TOKEN = creds.token;
    }
    return env;
  }

  private globalArgs(remoteUrl?: string): string[] {
    const insecure = this.opts.allowInsecureProtocols === true;
    const url = remoteUrl && /^https:\/\//i.test(remoteUrl) ? new URL(remoteUrl) : null;
    const skip = url && skipsTlsVerification(url.hostname, this.opts.tlsSkipVerifyHosts ?? []);
    return [
      "-c", "credential.helper=",
      "-c", "core.symlinks=false",
      "-c", "core.autocrlf=false",
      "-c", "core.quotepath=false",
      "-c", `core.hooksPath=${this.hooks}`,
      "-c", "advice.detachedHead=false",
      "-c", "safe.directory=*",
      "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always",
      ...(skip ? [
        "-c", `http.${url.origin}/.sslVerify=false`,
        // Git choisit la configuration TLS avant les redirections : ne pas étendre l'exception.
        "-c", `http.${url.origin}/.followRedirects=false`,
      ] : []),
      ...(insecure ? ["-c", "protocol.file.allow=always", "-c", "protocol.http.allow=always"] : []),
    ];
  }

  run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const secrets = opts.creds ? [opts.creds.token] : [];
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [...this.globalArgs(opts.remoteUrl), ...args],
        {
          cwd: opts.cwd,
          env: this.env(opts.creds),
          timeout: opts.timeoutMs ?? 120_000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const clean = (t: string): string => redact(t, secrets).replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***@");
          const out = { stdout: clean(stdout), stderr: clean(stderr), code: 0 };
          if (!err) return resolve(out);
          const exit = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
          out.code = exit;
          if (opts.allowFail && !(err as { killed?: boolean }).killed) return resolve(out);
          const detail = out.stderr.trim() || clean(err.message);
          reject(new GitError(detail.split("\n").slice(-3).join(" ").slice(0, 400), (err as { killed?: boolean }).killed ? "network" : classifyGitError(detail)));
        },
      );
    });
  }
}

/** Message de l'API pour une erreur Git (sans détail sensible). */
export function gitErrorToHttp(err: unknown): HttpError {
  if (!(err instanceof GitError)) throw err;
  switch (err.code) {
    case "auth":
      return new HttpError(422, "git_auth_failed", "Authentification Git refusée : vérifiez l'identifiant et le jeton (droits d'écriture requis).");
    case "not_found":
      return new HttpError(422, "git_repo_not_found", "Dépôt introuvable ou inaccessible avec ces identifiants.");
    case "tls":
      return new HttpError(502, "git_tls_error", "Certificat TLS du serveur Git non valide ou non reconnu.");
    case "network":
      return new HttpError(502, "git_unreachable", "Serveur Git injoignable.");
    default:
      return new HttpError(502, "git_error", `Erreur Git : ${err.message}`);
  }
}

/** Valide l'URL d'un dépôt : HTTPS uniquement, sans identifiants intégrés. */
export function validateRepoUrl(raw: string, allowInsecure = false): string {
  const value = raw.trim();
  const bad = (msg: string): never => {
    throw new HttpError(400, "invalid_repo_url", msg);
  };
  if (value.length === 0 || value.length > 512 || /[\s\p{Cc}]/u.test(value) || value.startsWith("-")) {
    bad("URL de dépôt invalide.");
  }
  if (allowInsecure && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value; // chemin local (tests)
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad("URL de dépôt invalide.");
  }
  const okProtocol = url.protocol === "https:" || (allowInsecure && (url.protocol === "http:" || url.protocol === "file:"));
  if (!okProtocol) bad("Seules les URL HTTPS sont acceptées (https://…).");
  if (url.username || url.password) bad("N'incluez pas d'identifiants dans l'URL : utilisez les champs identifiant et jeton.");
  if (url.protocol !== "file:" && !url.hostname) bad("URL de dépôt invalide.");
  return value;
}

export function validateBranch(branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new HttpError(400, "invalid_branch", "Nom de branche invalide.");
  }
  return branch;
}
