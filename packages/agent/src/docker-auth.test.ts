import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authKey, isAuthDenied, prepareDockerAuth } from "./docker-auth.js";

describe("prepareDockerAuth", () => {
  it("sans identifiants : environnement inchangé, rien d'écrit", async () => {
    const base = { PATH: "/bin" };
    const a = await prepareDockerAuth(base, undefined);
    expect(a.active).toBe(false);
    expect(a.env).toBe(base);
    await a.cleanup();
  });

  it("écrit une configuration temporaire privée puis la supprime", async () => {
    const a = await prepareDockerAuth({ PATH: "/bin" }, [
      { registry: "ghcr.io", username: "valcriss", password: "ghp_secret" },
      { registry: "docker.io", username: "u", password: "p-secret" },
    ]);
    const dir = a.env.DOCKER_CONFIG as string;
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { auths: Record<string, { auth: string }> };
    expect(Buffer.from(cfg.auths["ghcr.io"]!.auth, "base64").toString()).toBe("valcriss:ghp_secret");
    expect(Object.keys(cfg.auths)).toContain("https://index.docker.io/v1/");
    if (process.platform !== "win32") expect(statSync(join(dir, "config.json")).mode & 0o077).toBe(0);
    expect(a.active).toBe(true);
    expect(a.secrets).toContain("ghp_secret");
    await a.cleanup();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("authKey / isAuthDenied", () => {
  it("clé historique pour Docker Hub", () => {
    expect(authKey("docker.io")).toBe("https://index.docker.io/v1/");
    expect(authKey("ghcr.io")).toBe("ghcr.io");
  });

  it("reconnaît un refus de registre", () => {
    expect(isAuthDenied("Error response from daemon: denied: permission_denied")).toBe(true);
    expect(isAuthDenied("pull access denied for x, repository does not exist or may require 'docker login'")).toBe(true);
    expect(isAuthDenied("Error response from daemon: manifest unknown")).toBe(false);
  });
});
