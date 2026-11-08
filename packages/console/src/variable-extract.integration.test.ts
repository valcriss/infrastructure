import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;

const COMPOSE = `services:
  ghost:
    image: ghost:6.75.0-alpine
    environment:
      # configuration de la base
      database__client: mysql
      database__connection__password: example
      url: https://example.com
      mail__options__port: 587
      mail__options__auth__user: AKIAIOSFODNN7EXAMPLE # clé AWS
      mail__options__auth__pass: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
      ALREADY: \${EXISTING}
  db:
    image: mysql:8.0
    environment:
      - MYSQL_ROOT_PASSWORD=example
      - TZ=UTC
`;

describe.skipIf(!url)("extraction de variables depuis le Compose (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let cookie = "";
  let root: string;
  let stackId = "";

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any>, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    root = mkdtempSync(join(tmpdir(), "infra-vars-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir: mkdtempSync(join(root, "shared-")), webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    cookie = (await call("POST", "/api/v1/setup", { setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" })).cookie;
    const host = await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash) VALUES ('hôte de test', 'x') RETURNING id");
    stackId = (await call("POST", "/api/v1/stacks", { name: "demo", hostId: host.rows[0]?.id, compose: COMPOSE, variables: { EXISTING: "v1" } })).json.id as string;
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  const proposal = async () => (await call("GET", `/api/v1/stacks/${stackId}/variables/extraction`)).json as { revision: number; groups: any[]; skipped: any[]; existing: string[] };
  const pick = (groups: any[], key: string) => groups.find((g) => g.uses.some((u: any) => u.key === key));
  const select = (g: any, encrypted = g.secret) => ({ name: g.name, encrypted, uses: g.uses });

  it("propose des groupes nommés sans double underscore, avec valeurs partagées et secrets détectés", async () => {
    const p = await proposal();
    expect(p.existing).toEqual(["EXISTING"]);
    const names = p.groups.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n: string) => !n.includes("__"))).toBe(true);

    const shared = pick(p.groups, "MYSQL_ROOT_PASSWORD");
    expect(shared).toMatchObject({ shared: true, secret: true, value: "example" });
    expect(shared.uses.map((u: any) => `${u.service}:${u.key}`).sort()).toEqual(["db:MYSQL_ROOT_PASSWORD", "ghost:database__connection__password"]);
    expect(pick(p.groups, "mail__options__auth__pass")).toMatchObject({ name: "MAIL_OPTIONS_AUTH_PASS", secret: true });
    expect(pick(p.groups, "mail__options__auth__user")).toMatchObject({ secret: true });
    expect(pick(p.groups, "url")).toMatchObject({ secret: false, shared: false });
    // Ce qui est déjà une variable n'est pas proposé.
    expect(p.groups.flatMap((g) => g.uses.map((u: any) => u.key))).not.toContain("ALREADY");
  });

  it("refuse les sélections incohérentes : nom en double, valeurs différentes, nom pris, révision périmée", async () => {
    const p = await proposal();
    const base = { expectedRevision: p.revision };
    const url_ = pick(p.groups, "url");
    const port = pick(p.groups, "mail__options__port");
    const post = (groups: unknown[], extra: Record<string, unknown> = {}) => call("POST", `/api/v1/stacks/${stackId}/variables/extraction/preview`, { ...base, groups, ...extra });

    // Un nom ne désigne qu'une valeur.
    expect((await post([{ ...select(url_), name: "X" }, { ...select(port), name: "X" }])).json.error.code).toBe("duplicate_name");
    // Un groupe qui mélangerait deux valeurs différentes.
    expect((await post([{ name: "MIX", encrypted: false, uses: [...url_.uses, ...port.uses] }])).json.error.code).toBe("value_mismatch");
    // Nom déjà pris par une variable existante de valeur différente.
    expect((await post([{ ...select(url_), name: "EXISTING" }])).json.error.code).toBe("name_taken");
    // Nom invalide, emplacement inconnu, révision périmée.
    expect((await post([{ ...select(url_), name: "1 mauvais" }])).json.error.code).toBe("invalid_variable_name");
    expect((await post([{ name: "Z", encrypted: false, uses: [{ service: "ghost", key: "inconnu" }] }])).json.error.code).toBe("value_changed");
    expect((await post([select(url_)], { expectedRevision: p.revision + 4 })).status).toBe(409);
  });

  it("extrait en une seule révision : Compose avec ${NOM}, variables créées, valeurs sensibles masquées, rien n'est déployé", async () => {
    const p = await proposal();
    const groups = [pick(p.groups, "MYSQL_ROOT_PASSWORD"), pick(p.groups, "mail__options__auth__pass"), pick(p.groups, "mail__options__auth__user"), pick(p.groups, "url")];
    const sel = groups.map((g) => select(g));

    const preview = await call("POST", `/api/v1/stacks/${stackId}/variables/extraction/preview`, { expectedRevision: p.revision, groups: sel });
    expect(preview.status).toBe(200);
    expect(preview.json.after).toContain("mail__options__auth__pass: ${MAIL_OPTIONS_AUTH_PASS}");
    expect(preview.json.after).toContain("mail__options__auth__user: ${MAIL_OPTIONS_AUTH_USER} # clé AWS");
    expect(preview.json.after).toContain("- MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}");
    expect(preview.json.after).toContain("# configuration de la base");
    expect(preview.json.variables.map((v: any) => v.name).sort()).toEqual(sel.map((g) => g.name).sort());
    // L'aperçu n'enregistre rien.
    expect((await call("GET", `/api/v1/stacks/${stackId}`)).json.currentRevision).toBe(p.revision);

    const done = await call("POST", `/api/v1/stacks/${stackId}/variables/extraction`, { expectedRevision: p.revision, groups: sel });
    expect(done.status).toBe(200);
    expect(done.json.revision).toBe(p.revision + 1);

    const detail = (await call("GET", `/api/v1/stacks/${stackId}`)).json;
    expect(detail.compose).toContain("${MAIL_OPTIONS_AUTH_PASS}");
    expect(detail.compose).not.toContain("wJalrXUtnFEMI/K7MDENG");
    expect(detail.deployedRevision).toBeNull();
    const vars = Object.fromEntries((detail.variables as any[]).map((v) => [v.name, v]));
    expect(vars.MAIL_OPTIONS_AUTH_PASS).toMatchObject({ sensitive: true, value: null }); // masquée
    expect(vars.MYSQL_ROOT_PASSWORD).toMatchObject({ sensitive: true, value: null });
    expect(vars.URL).toMatchObject({ sensitive: false, value: "https://example.com" });
    expect(vars.EXISTING).toMatchObject({ value: "v1" });

    // L'historique garde l'ancienne valeur (à faire changer par l'utilisateur) : la révision précédente est intacte.
    const old = (await call("GET", `/api/v1/stacks/${stackId}/revisions/${p.revision}`)).json;
    expect(old.compose).toContain("wJalrXUtnFEMI/K7MDENG");
    // Les valeurs n'apparaissent pas dans l'audit.
    const audit = await pool.query("SELECT target FROM audit_events WHERE action = 'variables.extract'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].target).not.toContain("wJalrXU");

    // Ce qui est déjà extrait n'est plus proposé ; ce qui reste l'est toujours.
    const after = await proposal();
    const left = after.groups.flatMap((g) => g.uses.map((u: any) => u.key));
    expect(left).not.toContain("MYSQL_ROOT_PASSWORD");
    expect(left).toContain("mail__options__port");
  });

  it("réutilise une variable existante de même valeur au lieu d'en créer une seconde", async () => {
    const p = await proposal();
    // « TZ=UTC » : on l'extrait sous le nom TZ, puis on propose à nouveau la même valeur dans un autre service.
    const tz = pick(p.groups, "TZ");
    const first = await call("POST", `/api/v1/stacks/${stackId}/variables/extraction`, { expectedRevision: p.revision, groups: [select(tz, false)] });
    expect(first.status).toBe(200);
    const revision = first.json.revision as number;
    const withTz = (await call("GET", `/api/v1/stacks/${stackId}`)).json.compose as string;
    expect(withTz).toContain("- TZ=${TZ}");
    // Le même nom et la même valeur existent déjà : seule la référence est remplacée.
    const next = `${withTz}  worker:\n    image: x:1\n    environment:\n      TZ: UTC\n`;
    await call("PUT", `/api/v1/stacks/${stackId}/compose`, { expectedRevision: revision, compose: next });
    const p2 = await proposal();
    const tz2 = pick(p2.groups, "TZ");
    expect(tz2).toMatchObject({ name: "TZ", reuse: true });
    const res = await call("POST", `/api/v1/stacks/${stackId}/variables/extraction/preview`, { expectedRevision: p2.revision, groups: [select(tz2, false)] });
    expect(res.status).toBe(200);
    expect(res.json.variables).toEqual([{ name: "TZ", sensitive: false, reused: true, uses: 1 }]);
  });
});
