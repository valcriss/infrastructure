import { describe, expect, it } from "vitest";
import { collectImageRefs, registriesOf } from "./registry-use.js";

describe("collectImageRefs", () => {
  it("lit les images des services et interpole les variables", () => {
    const compose = "services:\n  a:\n    image: ghcr.io/valcriss/app:${TAG:-1}\n  b:\n    image: ${REG}/team/b:2\n  c:\n    image: nginx\n  d:\n    build: .\n";
    expect(collectImageRefs(compose, { REG: "reg.local:5000" }, {}).sort()).toEqual(["ghcr.io/valcriss/app:1", "nginx", "reg.local:5000/team/b:2"]);
  });

  it("ignore les références non résolues", () => {
    expect(collectImageRefs("services:\n  a:\n    image: ${UNKNOWN}/x\n", {}, {})).toEqual([]);
  });

  it("lit les FROM des Dockerfiles joints, pas ceux des autres fichiers", () => {
    const files = {
      "build/web/Dockerfile": "FROM --platform=linux/amd64 ghcr.io/valcriss/base:1 AS base\nFROM scratch\nFROM base\n",
      "init.sql": "FROM users\n",
    };
    expect(collectImageRefs("services: {}\n", {}, files)).toEqual(["ghcr.io/valcriss/base:1", "base"]);
  });

  it("tolère un Compose illisible", () => {
    expect(collectImageRefs("services: [", {}, {})).toEqual([]);
  });
});

describe("registriesOf", () => {
  it("déduit les noms canoniques de registre", () => {
    expect([...registriesOf(["nginx", "valcriss/app:1", "ghcr.io/o/a:1", "reg.local:5000/t/a", "pas une image"])].sort()).toEqual(["docker.io", "ghcr.io", "reg.local:5000"]);
  });
});
