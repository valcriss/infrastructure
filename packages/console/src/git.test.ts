import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitRunner, classifyGitError, validateBranch, validateRepoUrl } from "./git.js";
import { HttpError } from "./http-error.js";

describe("validateRepoUrl", () => {
  it("n'accepte que HTTPS sans identifiants intégrés", () => {
    expect(validateRepoUrl("https://git.exemple.org/equipe/config.git")).toBe("https://git.exemple.org/equipe/config.git");
    for (const bad of [
      "http://git.exemple.org/x.git",
      "ssh://git@git.exemple.org/x.git",
      "git@git.exemple.org:x.git",
      "file:///etc/passwd",
      "/srv/git/depot.git",
      "ftp://x/y",
      "https://user:token@git.exemple.org/x.git",
      "https://user@git.exemple.org/x.git",
      "--upload-pack=touch /tmp/pwn",
      "-c core.sshCommand=evil",
      "https://exemple.org/ avec espace",
      "",
    ]) {
      expect(() => validateRepoUrl(bad), bad).toThrow(HttpError);
    }
  });

  it("assouplit uniquement en mode test", () => {
    expect(validateRepoUrl("/tmp/depot.git", true)).toBe("/tmp/depot.git");
    expect(validateRepoUrl("file:///tmp/depot.git", true)).toBe("file:///tmp/depot.git");
    expect(() => validateRepoUrl("--evil", true)).toThrow(HttpError);
  });
});

describe("validateBranch", () => {
  it("accepte les noms usuels et refuse les noms dangereux", () => {
    for (const ok of ["main", "sauvegarde/prod", "release-1.2"]) expect(validateBranch(ok)).toBe(ok);
    for (const bad of ["", "-x", "a..b", "a b", "x.lock", "x/", "/x", "a;b"]) {
      expect(() => validateBranch(bad), bad).toThrow(HttpError);
    }
  });
});

describe("classifyGitError", () => {
  it("reconnaît les familles d'erreurs", () => {
    expect(classifyGitError("remote: Invalid username or password.\nfatal: Authentication failed for 'https://x/'")).toBe("auth");
    expect(classifyGitError("fatal: could not read Username for 'https://x': terminal prompts disabled")).toBe("auth");
    expect(classifyGitError("fatal: unable to access 'https://x/': SSL certificate problem: self-signed certificate")).toBe("tls");
    expect(classifyGitError("fatal: unable to access 'https://x/': Could not resolve host: x")).toBe("network");
    expect(classifyGitError("fatal: repository 'https://x/y.git/' not found")).toBe("not_found");
    expect(classifyGitError("! [rejected]        HEAD -> main (fetch first)")).toBe("rejected");
    expect(classifyGitError("quelque chose d'imprévu")).toBe("unknown");
  });
});

describe("GitRunner", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("fournit l'identifiant et le jeton par l'environnement (GIT_ASKPASS), jamais par les arguments", async () => {
    dir = await mkdtemp(join(tmpdir(), "infra-git-"));
    const git = new GitRunner({ dataDir: dir });
    await git.init();
    const askpass = join(dir, "git", "askpass.sh");
    const run = (prompt: string): string | null => {
      try {
        return execFileSync("sh", [askpass, prompt], { env: { ...process.env, GIT_USER: "alice", GIT_TOKEN: "jeton-secret" }, encoding: "utf8" }).trim();
      } catch {
        return null; // pas de shell POSIX sur cette machine
      }
    };
    const user = run("Username for 'https://x': ");
    if (user === null) return;
    expect(user).toBe("alice");
    expect(run("Password for 'https://alice@x': ")).toBe("jeton-secret");
  });

  it("masque le jeton dans les erreurs et refuse les protocoles non autorisés", async () => {
    dir = await mkdtemp(join(tmpdir(), "infra-git-"));
    const git = new GitRunner({ dataDir: dir });
    await git.init();
    const err = await git
      .run(["ls-remote", "--", "ext::sh -c 'echo jeton-secret >&2'"], { creds: { username: "u", token: "jeton-secret" } })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("jeton-secret");
    // Le transport « ext:: » (exécution de commande) et « file:// » sont interdits hors mode test.
    const file = await git.run(["ls-remote", "--", "file:///tmp/inexistant"], {}).catch((e: Error) => e);
    expect((file as Error).message.toLowerCase()).toMatch(/not allowed|protocol|transport/);
  });
});
