import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Reçoit la sortie standard et d'erreur au fil de l'eau. */
  onOutput?: (chunk: string) => void;
  /** Taille maximale de la sortie standard conservée dans `stdout`. */
  maxStdoutBytes?: number;
}

export interface ExecResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
}

/**
 * Lance un processus avec des arguments structurés (jamais de shell), un délai
 * et une sortie bornée. L'environnement est fourni explicitement : rien n'est
 * hérité implicitement du processus de l'agent.
 */
export function runCommand(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const max = opts.maxStdoutBytes ?? 1024 * 1024;
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (stdout.length < max) stdout += d.slice(0, max - stdout.length);
      opts.onOutput?.(d);
    });
    child.stderr.on("data", (d: string) => opts.onOutput?.(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout });
    });
  });
}

/** Environnement minimal pour la CLI Docker : aucune variable héritée de l'agent. */
export function dockerEnv(socketPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    DOCKER_HOST: `unix://${socketPath}`,
  };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

/**
 * Mise en ligne par ligne de la sortie : seules les lignes complètes sont
 * émises, pour qu'un secret coupé entre deux paquets ne puisse pas échapper au
 * masquage. `mask` est appliqué à chaque ligne avant émission.
 */
export class LineBuffer {
  private partial = "";
  private pending: string[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly mask: (line: string) => string,
    private readonly flushMs = 250,
  ) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.pending.push(this.mask(line));
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
    if (this.pending.join("\n").length > 16 * 1024) this.flush();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    this.emit(this.pending.join("\n") + "\n");
    this.pending = [];
  }

  end(): void {
    if (this.partial) {
      this.pending.push(this.mask(this.partial));
      this.partial = "";
    }
    this.flush();
  }
}
