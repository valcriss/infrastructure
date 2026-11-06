import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { parseSnapshot, readWorkTree } from "./backup-format.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;
const TOKEN = "jeton-git-ultra-secret";

const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n    ports:\n      - '${PORT}:80'\n";
const COMPOSE_SECRET = "services:\n  api:\n    image: x\n    environment:\n      API_TOKEN: compose-secret-token\n";

interface Konsole {
  built: BuiltApp;
  baseUrl: string;
  cookie: string;
  sharedDir: string;
  dataDir: string;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "", GIT_TERMINAL_PROMPT: "0" },
  });

describe.skipIf(!url)("sauvegarde Git et restauration (intégration)", () => {
  let pool: Pool;
  let root: string;
  let remote: string;
  let A: Konsole;
  let B: Konsole;
  let identity = "";
  let recipientA = "";
  let installationA = "";
  const dirs: string[] = [];

  const mk = (name: string): string => {
    const d = join(root, name);
    dirs.push(d);
    return d;
  };

  const boot = async (): Promise<Konsole> => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    const sharedDir = mkdtempSync(join(root, "shared-"));
    const dataDir = mkdtempSync(join(root, "data-"));
    const built = await buildApp({
      masterKey: randomBytes(32),
      allowInsecureGit: true,
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir, gitCaFile: null },
      pool,
    });
    await built.backup.start();
    const baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    const res = await fetch(`${baseUrl}/api/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" }),
    });
    expect(res.status).toBe(201);
    return { built, baseUrl, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "", sharedDir, dataDir };
  };

  const call = async (k: Konsole, method: string, path: string, body?: unknown) => {
    const res = await fetch(k.baseUrl + path, {
      method,
      headers: { cookie: k.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };

  const addHost = async (name: string): Promise<string> =>
    (await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash) VALUES ($1, 'x') RETURNING id", [name])).rows[0]?.id as string;

  const sync = (k: Konsole) => call(k, "POST", "/api/v1/backup/sync?wait=true");
  const commits = (): number => {
    try {
      return Number(git(remote, "rev-list", "--count", "main").trim());
    } catch {
      return 0; // branche pas encore créée
    }
  };
  const cloneRemote = (name = "clone"): string => {
    const d = mkdtempSync(join(root, `${name}-`));
    git(root, "clone", "-q", remote, d);
    return d;
  };
  const putConfig = (k: Konsole, repo: string) => call(k, "PUT", "/api/v1/backup/config", { url: repo, username: "alice", token: TOKEN, branch: "main" });

  beforeAll(async () => {
    pool = createPool(url as string);
    root = mkdtempSync(join(tmpdir(), "infra-backup-"));
    remote = mk("remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  });

  afterAll(async () => {
    await A?.built.app.close();
    await B?.built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  // === Console A : sauvegarde ===============================================================

  it("valide la configuration du dépôt et ne renvoie jamais le jeton", async () => {
    A = await boot();
    expect((await call(A, "GET", "/api/v1/backup/status")).json.state).toBe("not_configured");
    expect((await call(A, "PUT", "/api/v1/backup/config", { url: remote, username: "alice", branch: "main" })).status).toBe(400); // jeton requis
    expect((await call(A, "PUT", "/api/v1/backup/config", { url: remote, username: "a b", token: TOKEN })).status).toBe(400);
    expect((await call(A, "PUT", "/api/v1/backup/config", { url: remote, username: "alice", token: TOKEN, branch: "a..b" })).status).toBe(400);
    expect((await call(A, "PUT", "/api/v1/backup/config", { url: "--upload-pack=x", username: "alice", token: TOKEN })).status).toBe(400);

    const ok = await putConfig(A, remote);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ configured: true, enabled: true, username: "alice", branch: "main" });
    expect(JSON.stringify(ok.json)).not.toContain(TOKEN);
    const row = (await pool.query("SELECT * FROM backup_settings")).rows[0];
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row.token_enc).toMatch(/^v1:/);
  });

  it("bloque la synchronisation tant qu'il n'y a pas de clé de restauration", async () => {
    const r = await sync(A);
    expect(r.json).toMatchObject({ state: "blocked", lastError: { code: "no_recipient" } });
    expect(commits()).toBe(0);
    const key = await call(A, "POST", "/api/v1/admin/restoration-key");
    expect(key.status).toBe(201);
    identity = key.json.restorationKey;
    recipientA = key.json.recipient;
    installationA = (await call(A, "GET", "/api/v1/backup/status")).json.installationId;
  });

  it("sauvegarde stacks, variables, fichiers et secrets chiffrés dans un dépôt unique", async () => {
    const host = await addHost("hôte A");
    const s1 = await call(A, "POST", "/api/v1/stacks", {
      name: "app1",
      hostId: host,
      compose: COMPOSE,
      description: "première",
      variables: { PORT: "8080", DB_PASSWORD: { value: "sup3r-secret-value", sensitive: true } },
    });
    expect(s1.status).toBe(201);
    expect(s1.json.backup.status).toBe("pending"); // configuré : le push est asynchrone
    const id1 = s1.json.id as string;
    await call(A, "PUT", `/api/v1/stacks/${id1}/files/conf/app.conf`, { expectedRevision: 1, content: "x=1" });
    await call(A, "PUT", `/api/v1/stacks/${id1}/files/tls/key.pem`, { expectedRevision: 2, content: "-----BEGIN PRIVATE KEY-----", sensitive: true });
    const s2 = await call(A, "POST", "/api/v1/stacks", { name: "chiffre", hostId: host, compose: COMPOSE_SECRET, composeSensitive: true });
    expect(s2.status).toBe(201);

    const st = (await sync(A)).json;
    expect(st).toMatchObject({ state: "ok", pendingRevisions: 0, lastError: null });
    expect(st.lastPushAt).not.toBeNull();
    expect(st.pushedCommit).toBe(st.localCommit);
    expect(commits()).toBe(1);

    // Le dépôt se relit entièrement avec la clé de restauration…
    const tree = await readWorkTree(cloneRemote());
    const parsed = await parseSnapshot(tree, identity);
    expect(parsed.stacks.map((s) => s.name).sort()).toEqual(["app1", "chiffre"]);
    expect(parsed.installationId).toBe(installationA);
    const app1 = parsed.stacks.find((s) => s.name === "app1");
    expect(app1?.content.variables.DB_PASSWORD).toEqual({ value: "sup3r-secret-value", sensitive: true });
    expect(app1?.content.sensitiveFiles).toEqual(["tls/key.pem"]);
    expect(parsed.stacks.find((s) => s.name === "chiffre")?.content.composeSensitive).toBe(true);

    // … et aucun secret n'est en clair dans le dépôt, ni dans l'historique Git.
    const history = git(remote, "log", "-p", "--all");
    for (const secret of ["sup3r-secret-value", "BEGIN PRIVATE KEY", "compose-secret-token", TOKEN]) {
      expect(history, secret).not.toContain(secret);
    }
    expect(git(remote, "ls-tree", "-r", "--name-only", "main")).toContain(`secrets/${id1}/variables.age`);
  });

  it("ne crée aucun commit sans changement, et garde les secrets inchangés identiques", async () => {
    const before = git(remote, "rev-parse", "main").trim();
    await sync(A);
    expect(git(remote, "rev-parse", "main").trim()).toBe(before);
    expect(commits()).toBe(1);

    const id1 = (await call(A, "GET", "/api/v1/stacks")).json.stacks.find((s: any) => s.name === "app1").id as string;
    const cur = (await call(A, "GET", `/api/v1/stacks/${id1}`)).json.currentRevision as number;
    await call(A, "PATCH", `/api/v1/stacks/${id1}/variables`, { expectedRevision: cur, set: { PORT: "9090" } });
    expect((await sync(A)).json.state).toBe("ok");
    expect(commits()).toBe(2);
    const path = `secrets/${id1}/files/tls/key.pem.age`;
    expect(git(remote, "show", `main:${path}`)).toBe(git(remote, "show", `main~1:${path}`)); // pas de re-chiffrement inutile
    expect(git(remote, "show", `main:stacks/${id1}/variables.yaml`)).toContain("9090");
  });

  it("reste fonctionnel quand Git est indisponible, puis reprend sans rien perdre", async () => {
    const gone = remote + ".indisponible";
    execFileSync(process.platform === "win32" ? "cmd" : "mv", process.platform === "win32" ? ["/c", "move", remote, gone] : [remote, gone]);
    try {
      const id1 = (await call(A, "GET", "/api/v1/stacks")).json.stacks.find((s: any) => s.name === "app1").id as string;
      const cur = (await call(A, "GET", `/api/v1/stacks/${id1}`)).json.currentRevision as number;
      const change = await call(A, "PATCH", `/api/v1/stacks/${id1}/variables`, { expectedRevision: cur, set: { PORT: "7070" } });
      expect(change.status).toBe(200); // la gestion des stacks continue
      expect(change.json.backup.status).toBe("pending");

      const down = (await sync(A)).json;
      expect(down.state).toBe("error");
      expect(down.lastError.code).toMatch(/^git_/);
      expect(down.pendingRevisions).toBeGreaterThan(0);
      expect(down.nextRetryAt).not.toBeNull(); // temporisation progressive
    } finally {
      execFileSync(process.platform === "win32" ? "cmd" : "mv", process.platform === "win32" ? ["/c", "move", gone, remote] : [gone, remote]);
    }
    const back = (await sync(A)).json;
    expect(back).toMatchObject({ state: "ok", pendingRevisions: 0, lastError: null });
    expect(commits()).toBe(3);
  });

  it("n'écrase jamais un dépôt qui a évolué : divergence bloquante, sans force push", async () => {
    const other = cloneRemote("autre");
    writeFileSync(join(other, "README.md"), "# Documentation ajoutée à la main\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "ajout manuel");
    git(other, "push", "-q", "origin", "HEAD:main");
    const tip = git(remote, "rev-parse", "main").trim();

    const id1 = (await call(A, "GET", "/api/v1/stacks")).json.stacks.find((s: any) => s.name === "app1").id as string;
    const cur = (await call(A, "GET", `/api/v1/stacks/${id1}`)).json.currentRevision as number;
    await call(A, "PATCH", `/api/v1/stacks/${id1}/variables`, { expectedRevision: cur, set: { PORT: "6060" } });

    const blocked = (await sync(A)).json;
    expect(blocked).toMatchObject({ state: "blocked", lastError: { code: "diverged" } });
    expect(git(remote, "rev-parse", "main").trim()).toBe(tip); // distant intact
    expect((await sync(A)).json.state).toBe("blocked"); // une relance manuelle ne force rien
    expect(git(remote, "rev-parse", "main").trim()).toBe(tip);
  });

  it("refuse un dépôt non vide qui ne vient pas de cette installation, et le détecte au test", async () => {
    const stranger = mk("autre-depot.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", stranger]);
    const seed = mkdtempSync(join(root, "seed-"));
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "fichier.txt"), "autre projet");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "init");
    git(seed, "push", "-q", stranger, "HEAD:main");
    const empty = mk("vide.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", empty]);

    const test = (repo: string) => call(A, "POST", "/api/v1/backup/test", { url: repo, username: "alice", token: TOKEN, branch: "main" });
    expect((await test(empty)).json.remote).toBe("empty");
    expect((await test(stranger)).json.remote).toBe("foreign_content");
    const known = (await test(remote)).json;
    expect(known.remote).toBe("has_backup");
    expect(known.backup).toMatchObject({ installationId: installationA, sameInstallation: true });
    expect((await test(join(root, "inexistant.git"))).status).toBe(422);

    await putConfig(A, stranger);
    expect((await sync(A)).json).toMatchObject({ state: "blocked", lastError: { code: "remote_not_empty" } });
    expect(git(stranger, "rev-list", "--count", "main").trim()).toBe("1");
  });

  // === Console B : restauration sur une installation vierge =====================================

  it("restaure la configuration sur une console vierge, avec la clé de restauration", async () => {
    await A.built.app.close();
    B = await boot(); // base vierge, nouvelle clé maître, nouvel identifiant d'installation
    const hostB = await addHost("hôte B");
    expect((await putConfig(B, remote)).status).toBe(200);

    const t = (await call(B, "POST", "/api/v1/backup/test", { url: remote, username: "alice", token: TOKEN, branch: "main" })).json;
    expect(t).toMatchObject({ remote: "has_backup", backup: { installationId: installationA, sameInstallation: false } });

    // Clé absente, fausse, puis bonne.
    const noKey = await call(B, "POST", "/api/v1/backup/restore/preview", {});
    expect(noKey.status).toBe(400);
    expect(noKey.json.error.code).toBe("restoration_key_required");
    const wrong = await call(B, "POST", "/api/v1/backup/restore/preview", { restorationKey: "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe("invalid_restoration_key");

    const preview = await call(B, "POST", "/api/v1/backup/restore/preview", { restorationKey: identity });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ installationId: installationA, hasSecrets: true, restorationKeyWillChange: false });
    expect(preview.json.stacks.map((s: any) => `${s.name}:${s.conflict}`).sort()).toEqual(["app1:none", "chiffre:none"]);
    expect(preview.json.availableHosts.map((h: any) => h.id)).toEqual([hostB]);

    const applied = await call(B, "POST", "/api/v1/backup/restore", { previewId: preview.json.previewId });
    expect(applied.status).toBe(200);
    expect(applied.json).toEqual({ created: 2, replaced: 0 });

    // Configuration restaurée, rien n'est déployé ni lancé.
    const stacks = (await call(B, "GET", "/api/v1/stacks")).json.stacks as any[];
    expect(stacks.map((s) => s.name).sort()).toEqual(["app1", "chiffre"]);
    for (const s of stacks) expect(s).toMatchObject({ deployedRevision: null, hostId: hostB, currentRevision: 1 });
    expect((await pool.query("SELECT count(*)::int AS n FROM operations")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT bool_and(adopt_pending) AS a FROM stacks")).rows[0].a).toBe(true);

    const app1 = (await call(B, "GET", `/api/v1/stacks/${stacks.find((s) => s.name === "app1").id}`)).json;
    expect(app1.variables).toContainEqual({ name: "DB_PASSWORD", value: null, sensitive: true });
    // 7070 : dernière valeur réellement poussée ; la modification 6060 bloquée par la divergence n'a jamais atteint Git.
    expect(app1.variables).toContainEqual({ name: "PORT", value: "7070", sensitive: false });
    expect(app1.sensitiveFiles).toEqual(["tls/key.pem"]);
    expect(app1.files).toEqual(["conf/app.conf", "tls/key.pem"]);
    expect((await call(B, "GET", `/api/v1/stacks/${stacks.find((s) => s.name === "chiffre").id}`)).json).toMatchObject({ composeSensitive: true });

    // Continuité : même installation et même clé de restauration que l'originale.
    expect((await call(B, "GET", "/api/v1/admin/restoration-key")).json.recipient).toBe(recipientA);
    const status = (await call(B, "GET", "/api/v1/backup/status")).json;
    expect(status).toMatchObject({ installationId: installationA, state: "ok", pendingRevisions: 0 });
    expect(status.pushedCommit).toBe(git(remote, "rev-parse", "main").trim());
  });

  it("poursuit l'historique du dépôt en avance rapide et préserve les fichiers étrangers", async () => {
    const before = git(remote, "rev-parse", "main").trim();
    expect(git(remote, "ls-tree", "-r", "--name-only", "main")).toContain("README.md");

    const id1 = (await call(B, "GET", "/api/v1/stacks")).json.stacks.find((s: any) => s.name === "app1").id as string;
    await call(B, "PATCH", `/api/v1/stacks/${id1}/variables`, { expectedRevision: 1, set: { PORT: "5050" } });
    expect((await sync(B)).json).toMatchObject({ state: "ok", lastError: null });

    const after = git(remote, "rev-parse", "main").trim();
    expect(after).not.toBe(before);
    git(remote, "merge-base", "--is-ancestor", before, after); // avance rapide : aucun historique réécrit
    expect(git(remote, "ls-tree", "-r", "--name-only", "main")).toContain("README.md"); // fichier étranger préservé
    expect(git(remote, "show", `main:stacks/${id1}/variables.yaml`)).toContain("5050");
  });

  it("exige un choix explicite pour remplacer des stacks existantes et pour associer les hôtes", async () => {
    const p1 = await call(B, "POST", "/api/v1/backup/restore/preview", { restorationKey: identity });
    expect(p1.json.stacks.map((s: any) => s.conflict)).toEqual(["same_id", "same_id"]);
    const conflict = await call(B, "POST", "/api/v1/backup/restore", { previewId: p1.json.previewId });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("restore_conflicts");
    expect(conflict.json.error.details.conflicts).toHaveLength(2);

    // Plusieurs hôtes enrôlés : l'association devient obligatoire.
    const hostC = await addHost("hôte C");
    const p2 = await call(B, "POST", "/api/v1/backup/restore/preview", { restorationKey: identity });
    const noMap = await call(B, "POST", "/api/v1/backup/restore", { previewId: p2.json.previewId, replaceStackIds: p2.json.stacks.map((s: any) => s.id) });
    expect(noMap.status).toBe(400);
    expect(noMap.json.error.code).toBe("host_mapping_required");

    const mapping = Object.fromEntries(p2.json.backupHosts.map((h: any) => [h.id, hostC]));
    const ok = await call(B, "POST", "/api/v1/backup/restore", { previewId: p2.json.previewId, hostMapping: mapping, replaceStackIds: p2.json.stacks.map((s: any) => s.id) });
    expect(ok.json).toEqual({ created: 0, replaced: 2 });
    const id1 = (await call(B, "GET", "/api/v1/stacks")).json.stacks.find((s: any) => s.name === "app1").id as string;
    expect((await call(B, "GET", `/api/v1/stacks/${id1}`)).json.currentRevision).toBe(3); // nouvelle révision, rien de supprimé
    expect((await call(B, "POST", "/api/v1/backup/restore", { previewId: "00000000-0000-4000-8000-000000000000" })).status).toBe(410);
  });

  it("refuse une sauvegarde altérée sans rien importer", async () => {
    const tampered = mk("altere.git");
    execFileSync("git", ["clone", "-q", "--bare", remote, tampered]);
    const work = mkdtempSync(join(root, "work-"));
    git(root, "clone", "-q", tampered, work);
    const id = (await call(B, "GET", "/api/v1/stacks")).json.stacks[0].id as string;
    writeFileSync(join(work, "stacks", id, "malveillant.sh"), "rm -rf /");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "altération");
    git(work, "push", "-q", "origin", "HEAD:main");

    const stacksBefore = (await pool.query("SELECT count(*)::int AS n FROM stacks")).rows[0].n;
    await putConfig(B, tampered);
    const r = await call(B, "POST", "/api/v1/backup/restore/preview", { restorationKey: identity });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("invalid_backup");
    expect((await pool.query("SELECT count(*)::int AS n FROM stacks")).rows[0].n).toBe(stacksBefore);
  });
});
