import { describe, expect, it } from "vitest";
import { validateCompose } from "./compose.js";
import { redact, validateFilePath, validateStackName, validateVariableName, validateVariableValue } from "./stack.js";

describe("validateCompose", () => {
  it("accepte un Compose valide et liste les services", () => {
    const r = validateCompose("services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n");
    expect(r).toEqual({ ok: true, services: ["web", "db"] });
  });

  it("localise une erreur de syntaxe YAML", () => {
    const r = validateCompose("services:\n  web:\n    image: [nginx\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.line).toBeGreaterThan(0);
  });

  it("rejette build et include explicitement", () => {
    const build = validateCompose("services:\n  web:\n    build: .\n");
    expect(build.ok).toBe(false);
    if (!build.ok) expect(build.issues[0]?.message).toContain("build");
    const inc = validateCompose("include:\n  - other.yaml\nservices:\n  w:\n    image: x\n");
    expect(inc.ok).toBe(false);
  });

  it("exige au moins un service avec une image", () => {
    expect(validateCompose("services: {}\n").ok).toBe(false);
    expect(validateCompose("services:\n  web:\n    ports: ['80:80']\n").ok).toBe(false);
    expect(validateCompose("- a\n- b\n").ok).toBe(false);
  });

  it("rejette les clés dupliquées", () => {
    expect(validateCompose("services:\n  a:\n    image: x\n  a:\n    image: y\n").ok).toBe(false);
  });
});

describe("noms et chemins", () => {
  it("valide les noms de stack", () => {
    expect(validateStackName("mon-app_1")).toBeNull();
    expect(validateStackName("Mon App")).not.toBeNull();
    expect(validateStackName("-x")).not.toBeNull();
    expect(validateStackName("console-docker")).not.toBeNull();
  });

  it("rejette les chemins qui sortent du dossier", () => {
    for (const p of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a//b", "./a", "", ".env", "compose.yaml"]) {
      expect(validateFilePath(p), p).not.toBeNull();
    }
    expect(validateFilePath("nginx/conf.d/default.conf")).toBeNull();
  });

  it("valide les variables", () => {
    expect(validateVariableName("IMAGE_TAG")).toBeNull();
    expect(validateVariableName("1BAD")).not.toBeNull();
    expect(validateVariableName("A-B")).not.toBeNull();
    expect(validateVariableValue("ok")).toBeNull();
    expect(validateVariableValue("a\nb")).not.toBeNull();
  });

  it("masque les secrets sans toucher aux valeurs trop courtes", () => {
    expect(redact("token=abcd1234 et x", ["abcd1234", "x"])).toBe("token=*** et x");
  });
});
