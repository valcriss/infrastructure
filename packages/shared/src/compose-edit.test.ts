import { describe, expect, it } from "vitest";
import { ComposeEditError, editServiceEnvironment, editServiceHealthcheck, validateHealthcheck } from "./compose-edit.js";

const MAP_FORM = `# Mon application
services:
  web:
    image: nginx:1.27 # image figée
    environment:
      # niveau de logs
      LOG_LEVEL: info
      DATABASE_URL: postgres://\${DB_USER}:\${DB_PASS}@db/app
      FALLBACK: \${FALLBACK:-valeur}
    ports:
      - "8080:80"
  db:
    image: postgres:17
`;

const LIST_FORM = `services:
  web:
    image: nginx
    environment:
      - LOG_LEVEL=info # commentaire
      - PASSTHROUGH
      - DATABASE_URL=postgres://\${DB_USER}@db/app
`;

describe("editServiceEnvironment — forme mapping", () => {
  it("modifie une valeur en conservant commentaires et expressions", () => {
    const out = editServiceEnvironment(MAP_FORM, "web", { LOG_LEVEL: "debug" }, []);
    expect(out).toContain("LOG_LEVEL: debug");
    expect(out).toContain("# Mon application");
    expect(out).toContain("# image figée");
    expect(out).toContain("# niveau de logs");
    expect(out).toContain("DATABASE_URL: postgres://${DB_USER}:${DB_PASS}@db/app");
    expect(out).toContain("FALLBACK: ${FALLBACK:-valeur}");
    // Seule la ligne modifiée diffère.
    const before = MAP_FORM.split("\n");
    const after = out.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after.filter((l, i) => l !== before[i])).toEqual(["      LOG_LEVEL: debug"]);
  });

  it("ajoute et supprime des variables", () => {
    const out = editServiceEnvironment(MAP_FORM, "web", { NEW_VAR: "1" }, ["FALLBACK"]);
    expect(out).toContain('NEW_VAR: "1"');
    expect(out).not.toContain("FALLBACK");
    expect(out).toContain("LOG_LEVEL: info");
  });

  it("crée la section environment quand elle n'existe pas, sans toucher au reste", () => {
    const out = editServiceEnvironment(MAP_FORM, "db", { POSTGRES_DB: "app" }, []);
    expect(out).toContain("POSTGRES_DB: app");
    expect(out).toContain("# Mon application");
    // Retirer la variable ajoutée restitue le document d'origine.
    expect(editServiceEnvironment(out, "db", {}, ["POSTGRES_DB"])).toBe(MAP_FORM);
  });

  it("supprime la section devenue vide", () => {
    const only = "services:\n  a:\n    image: x\n    environment:\n      K: v\n";
    expect(editServiceEnvironment(only, "a", {}, ["K"])).toBe("services:\n  a:\n    image: x\n");
  });

  it("conserve une indentation de 4 espaces et le style de guillemets", () => {
    const src = "services:\n    web:\n        image: x\n        ports:\n            - '80:80'\n        environment:\n            A: '1'\n";
    const out = editServiceEnvironment(src, "web", { B: "2" }, []);
    expect(out).toContain("            - '80:80'");
    expect(out).toContain("            A: '1'");
    expect(out).toContain("            B: '2'");
  });

  it("conserve des listes non indentées avec 2 espaces", () => {
    const src = "services:\n  web:\n    image: x\n    ports:\n    - '80:80'\n    environment:\n      A: '1'\n";
    const out = editServiceEnvironment(src, "web", { B: "2" }, []);
    expect(out).toContain("    ports:\n    - '80:80'");
  });
});

describe("editServiceEnvironment — forme liste", () => {
  it("remplace, ajoute et supprime sans toucher aux autres entrées", () => {
    const out = editServiceEnvironment(LIST_FORM, "web", { LOG_LEVEL: "debug", EXTRA: "x y" }, ["PASSTHROUGH"]);
    expect(out).toContain("- LOG_LEVEL=debug # commentaire");
    expect(out).toContain("- EXTRA=x y");
    expect(out).not.toContain("PASSTHROUGH");
    expect(out).toContain("- DATABASE_URL=postgres://${DB_USER}@db/app");
    // Reste une liste : jamais transformée en mapping.
    expect(out).not.toContain("LOG_LEVEL:");
  });
});

describe("editServiceEnvironment — refus explicites", () => {
  it("service inconnu", () => {
    expect(() => editServiceEnvironment(MAP_FORM, "absent", { A: "1" }, [])).toThrow(ComposeEditError);
    try {
      editServiceEnvironment(MAP_FORM, "absent", { A: "1" }, []);
    } catch (e) {
      expect((e as ComposeEditError).code).toBe("service_not_found");
    }
  });

  it("alias YAML et clé de fusion", () => {
    const alias = "x-env: &env\n  A: '1'\nservices:\n  web:\n    image: x\n    environment: *env\n";
    expect(() => editServiceEnvironment(alias, "web", { B: "2" }, [])).toThrow(/alias/);
    const merge = "x-base: &base\n  environment:\n    A: '1'\nservices:\n  web:\n    <<: *base\n    image: x\n";
    expect(() => editServiceEnvironment(merge, "web", { B: "2" }, [])).toThrow(/fusion/);
  });

  it("YAML invalide", () => {
    expect(() => editServiceEnvironment("services: [", "web", {}, [])).toThrow(ComposeEditError);
  });
});

describe("editServiceHealthcheck", () => {
  const spec = { test: "redis-cli ping", interval: "30s", timeout: "10s", retries: 5, startPeriod: "30s" };

  it("ajoute un healthcheck en conservant le reste et les commentaires", () => {
    const out = editServiceHealthcheck("services:\n  db:\n    image: redis # cache\n", "db", spec);
    expect(out).toContain("image: redis # cache");
    expect(out).toContain("healthcheck:");
    expect(out).toContain("CMD-SHELL");
    expect(out).toContain("start_period: 30s");
  });

  it("remplace un healthcheck existant", () => {
    const out = editServiceHealthcheck("services:\n  db:\n    image: x\n    healthcheck:\n      test: [CMD, old]\n", "db", spec);
    expect(out).not.toContain("old");
    expect(out).toContain("redis-cli ping");
  });

  it("refuse un service inconnu et une clé de fusion", () => {
    expect(() => editServiceHealthcheck("services:\n  a:\n    image: x\n", "b", spec)).toThrow(ComposeEditError);
    expect(() => editServiceHealthcheck("services:\n  a:\n    <<: {image: x}\n", "a", spec)).toThrow(ComposeEditError);
  });

  it("valide les durées et les essais", () => {
    expect(validateHealthcheck(spec)).toBeNull();
    expect(validateHealthcheck({ ...spec, interval: "vite" })).not.toBeNull();
    expect(validateHealthcheck({ ...spec, retries: 0 })).not.toBeNull();
    expect(validateHealthcheck({ ...spec, test: " " })).not.toBeNull();
  });
});
