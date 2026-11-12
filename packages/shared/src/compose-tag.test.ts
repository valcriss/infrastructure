import { describe, expect, it } from "vitest";
import { ComposeEditError } from "./compose-edit.js";
import { editServiceImageTag } from "./compose-tag.js";

describe("editServiceImageTag", () => {
  it("change l'étiquette en conservant le reste et les commentaires", () => {
    const text = "services:\n  ghost:\n    image: ghost:bookworm # figée\n    restart: always\n  reg:\n    image: myreg.local:5000/team/app\n";
    const out = editServiceImageTag(text, "ghost", "6.75-alpine");
    expect(out).toMatchObject({ from: "ghost:bookworm", to: "ghost:6.75-alpine" });
    expect(out.compose).toContain("image: ghost:6.75-alpine # figée");
    expect(out.compose).toContain("restart: always");
    // Registre avec port : seule l'étiquette change.
    expect(editServiceImageTag(text, "reg", "2.0").to).toBe("myreg.local:5000/team/app:2.0");
  });

  it("refuse les images paramétrées, épinglées, construites, identiques ou invalides", () => {
    const run = (image: string, tag = "2") => () => editServiceImageTag(`services:\n  a:\n    image: ${image}\n`, "a", tag);
    expect(run("${IMG:-x:1}")).toThrow(ComposeEditError);
    expect(run("x@sha256:" + "a".repeat(64))).toThrow(ComposeEditError);
    expect(run("x:2", "2")).toThrow(ComposeEditError);
    expect(run("x:1", "pas bon")).toThrow(ComposeEditError);
    expect(() => editServiceImageTag("services:\n  a:\n    build: ./build/a\n    image: x:l\n", "a", "2")).toThrow(ComposeEditError);
    expect(() => editServiceImageTag("services:\n  a:\n    image: x:1\n", "b", "2")).toThrow(ComposeEditError);
  });
});

import { editServiceImageRef, PATCHED_REF } from "./compose-tag.js";

describe("editServiceImageRef", () => {
  const REF = "registry.exemple.fr/patched/docker-io-library-alpine@sha256:" + "a".repeat(64);
  const compose = "services:\n  web:\n    image: alpine:3.22.0 # à corriger\n    restart: always\n  db:\n    image: postgres:17\n";

  it("remplace l'image par la référence corrigée en conservant commentaires et autres services", () => {
    const out = editServiceImageRef(compose, "web", REF);
    expect(out).toMatchObject({ from: "alpine:3.22.0", to: REF });
    expect(out.compose).toContain(`image: ${REF} # à corriger`);
    expect(out.compose).toContain("restart: always");
    expect(out.compose).toContain("image: postgres:17");
    // Un nouveau correctif remplace le précédent (image déjà épinglée).
    const next = "registry.exemple.fr/patched/docker-io-library-alpine@sha256:" + "b".repeat(64);
    expect(editServiceImageRef(out.compose, "web", next).from).toBe(REF);
  });

  it("refuse les images paramétrées, les services construits, les références invalides et le remplacement par la même", () => {
    const run = (text: string, ref = REF) => () => editServiceImageRef(text, "web", ref);
    expect(run("services:\n  web:\n    image: ${IMG:-x:1}\n")).toThrow(ComposeEditError);
    expect(run("services:\n  web:\n    build: ./build/web\n    image: x:l\n")).toThrow(ComposeEditError);
    expect(run(compose, "alpine:3.22.0")).toThrow(ComposeEditError);
    expect(run(compose, REF + "\nimage: evil")).toThrow(ComposeEditError);
    expect(run(`services:\n  web:\n    image: ${REF}\n`)).toThrow(ComposeEditError);
    expect(() => editServiceImageRef(compose, "absent", REF)).toThrow(ComposeEditError);
  });

  it("n'accepte que registre/dépôt@sha256 en minuscules", () => {
    expect(PATCHED_REF.test(REF)).toBe(true);
    expect(PATCHED_REF.test("registry.exemple.fr:5000/patched/a@sha256:" + "0".repeat(64))).toBe(true);
    for (const bad of ["alpine@sha256:" + "a".repeat(64), "r.fr/a:tag", "r.fr/a@sha256:" + "A".repeat(64), "r.fr/a@sha256:abc", "R.fr/a@sha256:" + "a".repeat(64)]) expect(PATCHED_REF.test(bad)).toBe(false);
  });
});
