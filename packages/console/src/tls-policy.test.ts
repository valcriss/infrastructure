import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { GitRunner } from "./git.js";
import { createFetch, RegistryClient } from "./registry.js";
import { parseTlsSkipVerifyHosts, skipsTlsVerification } from "./tls-policy.js";

describe("TLS_SKIP_VERIFY_HOSTS", () => {
  it("normalise les entrees et conserve la verification par defaut", () => {
    expect(parseTlsSkipVerifyHosts(undefined)).toEqual([]);
    expect(parseTlsSkipVerifyHosts("  ")).toEqual([]);
    expect(parseTlsSkipVerifyHosts(" .CNAVTS.FR,git.example.org, .cnavts.fr ")).toEqual([".cnavts.fr", "git.example.org"]);
    expect(loadConfig({ DATABASE_URL: "postgres://localhost/test" }).tlsSkipVerifyHosts).toEqual([]);
    expect(loadConfig({ DATABASE_URL: "postgres://localhost/test", TLS_SKIP_VERIFY_HOSTS: ".cnavts.fr" }).tlsSkipVerifyHosts).toEqual([".cnavts.fr"]);
  });

  it.each(["*", "*.cnavts.fr", ".", ".localhost", ".127.0.0.1", "https://git.example.org", "git.example.org:443", "user@host", "a/path", "a,,b", "-host", "host.", "a..b"])("refuse une configuration invalide : %s", (raw) => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost/test", TLS_SKIP_VERIFY_HOSTS: raw })).toThrow("TLS_SKIP_VERIFY_HOSTS");
  });

  it("respecte les frontieres du domaine a toute profondeur", () => {
    for (const host of ["cnavts.fr", "git.cnavts.fr", "a.b.cnavts.fr", "GIT.CNAVTS.FR", "git.cnavts.fr."]) {
      expect(skipsTlsVerification(host, [".cnavts.fr"]), host).toBe(true);
    }
    for (const host of ["evilcnavts.fr", "cnavts.fr.example.org", "example.org"]) {
      expect(skipsTlsVerification(host, [".cnavts.fr"]), host).toBe(false);
    }
    expect(skipsTlsVerification("git.cnavts.fr", ["git.cnavts.fr"])).toBe(true);
    expect(skipsTlsVerification("a.git.cnavts.fr", ["git.cnavts.fr"])).toBe(false);
    expect(skipsTlsVerification("cnavts.fr", [])).toBe(false);
  });
});

describe("connexions HTTPS ciblees", () => {
  let dir: string;
  let server: Server;
  let port: number;
  let caFile: string;
  let realmHost = "localhost";
  const url = (host = "localhost", path = "/") => `https://${host}:${port}${path}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "infra-tls-"));
    caFile = join(dir, "cert.pem");
    const keyFile = join(dir, "key.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
      "-keyout", keyFile, "-out", caFile,
    ], { stdio: "ignore" });
    server = createServer({ key: await readFile(keyFile), cert: await readFile(caFile) }, (req, res) => {
      if (req.url?.startsWith("/redirect")) {
        res.writeHead(302, { location: url("127.0.0.1") }).end();
      } else if (req.url?.startsWith("/repo/")) {
        res.writeHead(404).end();
      } else if (req.url === "/v2/" && !req.headers.authorization) {
        res.writeHead(401, { "www-authenticate": `Bearer realm="${url(realmHost, "/token")}",service="test"` }).end();
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url?.startsWith("/token") ? { token: "test-token" } : {}));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Adresse HTTPS indisponible");
    port = address.port;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("ne desactive TLS que sur les hotes declares, meme apres redirection", async () => {
    const secure = await createFetch(null);
    await expect(secure(url())).rejects.toThrow();
    const targeted = await createFetch(null, ["localhost"]);
    expect((await targeted(url())).status).toBe(200);
    await expect(targeted(url("127.0.0.1"))).rejects.toThrow();
    await expect(targeted(url("localhost", "/redirect"))).rejects.toThrow();
    await expect(secure(url())).rejects.toThrow();
  });

  it("conserve le support des CA et verifie les noms des autres hotes", async () => {
    const trusted = await createFetch(caFile, ["other.example.org"]);
    expect((await trusted(url())).status).toBe(200);
    await expect(trusted(url("127.0.0.1"))).rejects.toThrow();
  });

  it("applique aussi la politique au service d'authentification du registre", async () => {
    const registry = new RegistryClient({
      credentials: async () => null,
      fetchFn: await createFetch(null, ["localhost"]),
      minGapMs: 0,
    });
    await expect(registry.testAccess(`localhost:${port}`)).resolves.toBeUndefined();
    realmHost = "127.0.0.1";
    try {
      const otherRealm = new RegistryClient({
        credentials: async () => null,
        fetchFn: await createFetch(null, ["localhost"]),
        minGapMs: 0,
      });
      await expect(otherRealm.testAccess(`localhost:${port}`)).rejects.toThrow("Certificat TLS");
    } finally {
      realmHost = "localhost";
    }
  });

  it("applique l'exception Git aux commandes reseau sans la generaliser", async () => {
    const git = new GitRunner({ dataDir: dir, tlsSkipVerifyHosts: ["localhost", ".cnavts.fr"] });
    await git.init();
    const remoteUrl = url("localhost", "/repo");
    await expect(git.run(["ls-remote", "--", remoteUrl], { remoteUrl })).rejects.toMatchObject({ code: "not_found" });
    const other = url("127.0.0.1", "/repo");
    await expect(git.run(["ls-remote", "--", other], { remoteUrl: other })).rejects.toThrow(/certificate|subject|SSL|TLS/i);
    await expect(git.run(["ls-remote", "--", remoteUrl])).rejects.toThrow(/certificate|subject|SSL|TLS/i);
    const redirect = url("localhost", "/redirect");
    await expect(git.run(["ls-remote", "--", redirect], { remoteUrl: redirect })).rejects.toThrow(/302|redirect/i);
    const trusted = new GitRunner({ dataDir: dir, caFile, tlsSkipVerifyHosts: ["other.example.org"] });
    await expect(trusted.run(["ls-remote", "--", remoteUrl], { remoteUrl })).rejects.toMatchObject({ code: "not_found" });
    await expect(trusted.run(["ls-remote", "--", other], { remoteUrl: other })).rejects.toThrow(/certificate|subject|SSL/i);
    for (const host of ["cnavts.fr", "a.b.cnavts.fr"]) {
      const target = `HTTPS://${host}:8443/repo`;
      expect((await git.run(["config", "--get-urlmatch", "http.sslVerify", target], { remoteUrl: target })).stdout.trim()).toBe("false");
      expect((await git.run(["config", "--get-urlmatch", "http.followRedirects", target], { remoteUrl: target })).stdout.trim()).toBe("false");
      expect((await git.run(["config", "--get-urlmatch", "http.sslVerify", "https://evilcnavts.fr/repo"], { remoteUrl: target, allowFail: true })).code).toBe(1);
    }
  });
});
