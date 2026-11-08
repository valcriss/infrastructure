import { describe, expect, it } from "vitest";
import { applyExtraction, detectEnvLiterals, looksSecret, proposeGroups, resolvedEnvironment, variableNameFor } from "./compose-vars.js";

const COMPOSE = `services:
  ghost:
    image: ghost:6.75.0-alpine
    environment:
      # configuration de la base
      database__client: mysql
      database__connection__host: db
      database__connection__password: example
      database__connection__database: ghost
      url: https://example.com
      mail__options__port: 587
      mail__options__auth__user: AKIAIOSFODNN7EXAMPLE # clé AWS
      mail__options__auth__pass: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
      NODE_ENV: production
      FROM_ENV:
      ALREADY: \${SOMETHING}
  db:
    image: mysql:8.0
    environment:
      - MYSQL_ROOT_PASSWORD=example
      - MYSQL_DATABASE=ghost
      - TZ=UTC
      - PRICE=a$$b
`;

describe("variableNameFor", () => {
  it("remplace les doubles underscores, met en majuscules et garde un nom valide", () => {
    expect(variableNameFor("mail__options__auth__pass")).toBe("MAIL_OPTIONS_AUTH_PASS");
    expect(variableNameFor("a.b-c")).toBe("A_B_C");
    expect(variableNameFor("__x___y__")).toBe("X_Y");
    expect(variableNameFor("1abc")).toBe("V_1ABC");
    expect(variableNameFor("---")).toBe("VAR");
  });
});

describe("detectEnvLiterals", () => {
  it("lit les deux formes d'environment, ignore variables existantes, héritées, vides", () => {
    const { uses } = detectEnvLiterals(COMPOSE);
    const keys = uses.map((u) => `${u.service}:${u.key}`);
    expect(keys).toContain("ghost:database__connection__password");
    expect(keys).toContain("db:MYSQL_ROOT_PASSWORD");
    expect(keys).not.toContain("ghost:ALREADY"); // déjà ${…}
    expect(keys).not.toContain("ghost:FROM_ENV"); // valeur héritée
    expect(uses.find((u) => u.key === "mail__options__port")?.value).toBe("587");
    expect(uses.find((u) => u.key === "PRICE")?.value).toBe("a$b"); // $$ → $
  });

  it("ignore un service à clé de fusion ou à alias, avec la raison", () => {
    const merge = detectEnvLiterals("services:\n  a:\n    <<: {image: x}\n    environment:\n      A: b\n");
    expect(merge.uses).toEqual([]);
    expect(merge.skipped[0]?.reason).toContain("fusion");
    const alias = detectEnvLiterals("x-env: &e\n  A: b\nservices:\n  a:\n    image: x\n    environment: *e\n");
    expect(alias.skipped[0]?.reason).toContain("alias");
  });
});

describe("looksSecret", () => {
  it("reconnaît les secrets par le nom ou par la forme de la valeur", () => {
    expect(looksSecret("DATABASE__CONNECTION__PASSWORD", "example")).toBe(true);
    expect(looksSecret("mail__options__auth__user", "AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(looksSecret("DSN", "postgres://app:pw@db/app")).toBe(true);
    expect(looksSecret("X", "a".repeat(10) + "1".repeat(20))).toBe(true);
    expect(looksSecret("database__client", "mysql")).toBe(false);
    expect(looksSecret("url", "https://example.com")).toBe(false);
  });
});

describe("proposeGroups", () => {
  const { uses } = detectEnvLiterals(COMPOSE);
  const groups = proposeGroups(uses);
  const byName = (n: string) => groups.find((g) => g.name === n);

  it("partage une valeur identique entre services sous des clés différentes", () => {
    const shared = groups.find((g) => g.value === "example");
    expect(shared).toMatchObject({ secret: true, shared: true });
    expect(shared?.uses.map((u) => `${u.service}:${u.key}`).sort()).toEqual(["db:MYSQL_ROOT_PASSWORD", "ghost:database__connection__password"]);
  });

  it("ne regroupe pas des valeurs banales de clés différentes, mais pas de doublon de nom", () => {
    // « ghost » est à la fois MYSQL_DATABASE et database__connection__database : valeur banale, clés différentes.
    expect(groups.filter((g) => g.value === "ghost")).toHaveLength(2);
    const names = groups.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    expect(byName("MAIL_OPTIONS_AUTH_PASS")?.secret).toBe(true);
    expect(byName("MAIL_OPTIONS_PORT")?.value).toBe("587");
    expect(groups.every((g) => !g.name.includes("__"))).toBe(true);
  });

  it("n'attribue jamais le même nom à deux valeurs différentes (préfixe de service, puis suffixe)", () => {
    const text = "services:\n  a:\n    image: x\n    environment:\n      PORT: 8080\n      A__B: un\n  b:\n    image: x\n    environment:\n      PORT: 9090\n      A_B: deux\n";
    const out = proposeGroups(detectEnvLiterals(text).uses);
    const names = out.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["PORT", "B_PORT", "A_B", "B_A_B"]));
  });

  it("réutilise une variable existante de même valeur et refuse de la confondre sinon", () => {
    const text = "services:\n  a:\n    image: x\n    environment:\n      TOKEN: secret-value-1\n      MODE: fast\n";
    const uses = detectEnvLiterals(text).uses;
    const same = proposeGroups(uses, { TOKEN: { value: "secret-value-1", sensitive: true } });
    expect(same.find((g) => g.name === "TOKEN")).toMatchObject({ reuse: true });
    const other = proposeGroups(uses, { TOKEN: { value: "autre", sensitive: true }, MODE: { value: "fast", sensitive: false } });
    expect(other.find((g) => g.uses[0]?.key === "TOKEN")).toMatchObject({ name: "A_TOKEN", reuse: false });
    expect(other.find((g) => g.uses[0]?.key === "MODE")).toMatchObject({ name: "MODE", reuse: true });
  });
});

describe("applyExtraction", () => {
  it("remplace par ${NOM} dans les deux formes, en conservant commentaires et le reste", () => {
    const out = applyExtraction(COMPOSE, [
      { service: "ghost", key: "mail__options__auth__pass", name: "MAIL_OPTIONS_AUTH_PASS" },
      { service: "ghost", key: "mail__options__auth__user", name: "MAIL_OPTIONS_AUTH_USER" },
      { service: "db", key: "MYSQL_ROOT_PASSWORD", name: "DB_PASSWORD" },
      { service: "ghost", key: "mail__options__port", name: "MAIL_OPTIONS_PORT" },
    ]);
    expect(out).toContain("mail__options__auth__pass: ${MAIL_OPTIONS_AUTH_PASS}");
    expect(out).toContain("mail__options__auth__user: ${MAIL_OPTIONS_AUTH_USER} # clé AWS");
    expect(out).toContain("- MYSQL_ROOT_PASSWORD=${DB_PASSWORD}");
    expect(out).toContain("mail__options__port: ${MAIL_OPTIONS_PORT}");
    expect(out).toContain("# configuration de la base");
    expect(out).toContain("database__client: mysql");
    expect(() => applyExtraction(COMPOSE, [{ service: "ghost", key: "inconnu", name: "X" }])).toThrow();
  });

  it("préserve l'environnement résolu quand les variables portent les mêmes valeurs", () => {
    const { uses } = detectEnvLiterals(COMPOSE);
    const groups = proposeGroups(uses);
    const replacements = groups.flatMap((g) => g.uses.map((u) => ({ service: u.service, key: u.key, name: g.name })));
    const vars = Object.fromEntries(groups.map((g) => [g.name, g.value]));
    const out = applyExtraction(COMPOSE, replacements);
    expect(resolvedEnvironment(out, vars)).toEqual(resolvedEnvironment(COMPOSE, {}));
    // Une valeur de variable différente est détectée comme une dérive.
    const drift = { ...vars, [groups[0]?.name as string]: "modifié" };
    expect(resolvedEnvironment(out, drift)).not.toEqual(resolvedEnvironment(COMPOSE, {}));
    // Le $$ d'origine devient un $ dans la variable, et reste un $ à l'interpolation.
    expect(resolvedEnvironment(out, vars).db?.PRICE).toBe("a$b");
  });
});
