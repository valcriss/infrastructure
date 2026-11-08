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

import { listComposeServices } from "./compose.js";
import { DEFAULT_METRICS_INTERVAL_SEC, AgentMessageSchema, ContainerSchema, ConsoleMessageSchema } from "./protocol.js";

describe("listComposeServices", () => {
  it("liste les services et repère ceux qui sont sous profile", () => {
    const text = "services:\n  web:\n    image: x\n  debug:\n    image: y\n    profiles: [debug]\n  db:\n    image: z\n";
    expect(listComposeServices(text)).toEqual([
      { name: "web", optional: false },
      { name: "debug", optional: true },
      { name: "db", optional: false },
    ]);
  });
  it("retourne une liste vide pour un YAML invalide", () => {
    expect(listComposeServices("services: [")).toEqual([]);
    expect(listComposeServices("- a")).toEqual([]);
  });
});

describe("protocole de supervision", () => {
  it("accepte des conteneurs avec ou sans informations de santé (compatibilité)", () => {
    const base = { id: "a", names: ["x"], image: "i", imageId: "sha256:1", state: "running", status: "Up", created: 1 };
    expect(ContainerSchema.safeParse(base).success).toBe(true);
    expect(ContainerSchema.safeParse({ ...base, health: "none", restartCount: 0, startedAt: "2026-11-06T10:00:00Z" }).success).toBe(true);
    expect(ContainerSchema.safeParse({ ...base, health: "malade" }).success).toBe(false);
  });

  it("valide les messages de métriques", () => {
    const sample = { containerId: "abc", name: "web-1", cpuPercent: null, memBytes: 1, memLimitBytes: 2, netRxBytes: 3, netTxBytes: 4 };
    const msg = { type: "metrics", observedAt: "2026-11-06T10:00:00.000Z", samples: [sample] };
    expect(AgentMessageSchema.safeParse(msg).success).toBe(true);
    expect(AgentMessageSchema.safeParse({ ...msg, samples: [{ ...sample, memBytes: -1 }] }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ ...msg, samples: [{ ...sample, cpuPercent: Number.NaN }] }).success).toBe(false);
  });

  it("garde l'intervalle de métriques optionnel dans le message d'accueil", () => {
    const welcome = { type: "welcome", protocol: 1, agentId: "11111111-1111-4111-8111-111111111111", heartbeatIntervalSec: 15, inventoryIntervalSec: 60 };
    expect(ConsoleMessageSchema.safeParse(welcome).success).toBe(true);
    expect(ConsoleMessageSchema.safeParse({ ...welcome, metricsIntervalSec: DEFAULT_METRICS_INTERVAL_SEC }).success).toBe(true);
  });
});

describe("validateCompose : images personnalisées", () => {
  it("accepte le build généré par la console (sous-dossier de build/ + image locale)", () => {
    expect(validateCompose("services:\n  web:\n    build: ./build/web\n    image: app-web-custom:local\n").ok).toBe(true);
    expect(validateCompose("services:\n  web:\n    build:\n      context: ./build/web\n      dockerfile: Dockerfile\n      args:\n        A: b\n    image: x:local\n").ok).toBe(true);
  });

  it("refuse les contextes hors de build/, les options risquées et l'absence de nom d'image", () => {
    for (const build of ["build: ..", "build: /", "build: ./build/../..", "build: https://github.com/x/y.git", "build:\n      context: ./build/web\n      secrets: [s]", "build:\n      dockerfile: Dockerfile"]) {
      const r = validateCompose(`services:\n  web:\n    ${build}\n    image: x:local\n`);
      expect(r.ok, build).toBe(false);
    }
    const noImage = validateCompose("services:\n  web:\n    build: ./build/web\n");
    expect(noImage.ok).toBe(false);
    if (!noImage.ok) expect(noImage.issues[0]?.message).toContain("image");
  });
});
