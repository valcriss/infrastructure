import { describe, expect, it } from "vitest";
import { ComposeEditError } from "./compose-edit.js";
import { editServiceImageTag, editServiceImageVariable, effectiveImageValue, serviceImageVariable } from "./compose-tag.js";

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

describe("image portée par une variable", () => {
  const compose = (image: string, extra = "") => `services:\n  worker:\n    image: ${image}\n${extra}`;

  it("reconnaît les formes où une variable porte toute l'image", () => {
    expect(serviceImageVariable(compose("${W:-alpine:3.22}"), "worker")).toEqual({ name: "W", defaultValue: "alpine:3.22", otherUses: 0 });
    expect(serviceImageVariable(compose("${W-alpine:3.22}"), "worker")).toMatchObject({ name: "W", defaultValue: "alpine:3.22" });
    expect(serviceImageVariable(compose("${W}"), "worker")).toEqual({ name: "W", defaultValue: null, otherUses: 0 });
    expect(serviceImageVariable(compose("$W"), "worker")).toMatchObject({ name: "W" });
  });

  it("ignore une image en clair, composée de plusieurs variables ou d'une forme non gérée", () => {
    for (const image of ["alpine:3.22", "${REG}/app:${TAG}", "reg.fr/app:${TAG}", "${W:?obligatoire}", "${W:+alpine}"]) {
      expect(serviceImageVariable(compose(image), "worker")).toBeNull();
    }
  });

  it("compte les autres usages de la variable", () => {
    const text = compose("${W:-alpine}", "    environment:\n      A: ${W}\n  autre:\n    image: ${W}\n");
    expect(serviceImageVariable(text, "worker")?.otherUses).toBe(2);
    // Un commentaire n'est pas un usage.
    expect(serviceImageVariable(compose("${W:-alpine} # voir ${W}"), "worker")?.otherUses).toBe(0);
  });

  it("valeur effective : celle de la stack si non vide, sinon le défaut", () => {
    const v = { name: "W", defaultValue: "alpine:3.22", otherUses: 0 };
    expect(effectiveImageValue(v, {})).toBe("alpine:3.22");
    expect(effectiveImageValue(v, { W: { value: "", sensitive: false } })).toBe("alpine:3.22");
    expect(effectiveImageValue(v, { W: { value: "nginx:1", sensitive: false } })).toBe("nginx:1");
    expect(effectiveImageValue({ ...v, defaultValue: null }, {})).toBeNull();
  });

  const ref = "reg.fr/patched/alpine@sha256:" + "a".repeat(64);

  it("change la variable, jamais le Compose", () => {
    const out = editServiceImageVariable(compose("${W:-alpine:3.22}"), "worker", ref, { OTHER: { value: "x", sensitive: true } });
    expect(out).toMatchObject({ name: "W", from: "alpine:3.22", to: ref });
    expect(out.variables).toEqual({ OTHER: { value: "x", sensitive: true }, W: { value: ref, sensitive: false } });
    const existing = editServiceImageVariable(compose("${W}"), "worker", ref, { W: { value: "alpine:3.21", sensitive: false } });
    expect(existing.from).toBe("alpine:3.21");
  });

  it("refuse les cas ambigus ou risqués", () => {
    const refuse = (text: string, vars = {}) => () => editServiceImageVariable(text, "worker", ref, vars);
    expect(refuse(compose("${REG}/app:${TAG}"))).toThrow(ComposeEditError);
    expect(refuse(compose("${W}", "    environment:\n      A: ${W}\n"))).toThrow(/utilisée ailleurs/);
    expect(refuse(compose("${W}"), { W: { value: "x", sensitive: true } })).toThrow(/sensible/);
    expect(refuse(compose("${W}"), { W: { value: ref, sensitive: false } })).toThrow(/déjà/);
    expect(refuse(compose("${W}", "    build: .\n"))).toThrow(/construit/);
    expect(() => editServiceImageVariable(compose("${W}"), "absent", ref, {})).toThrow(/introuvable/);
    expect(() => editServiceImageVariable(compose("${W}"), "worker", "alpine:3.22", {})).toThrow(/invalide/);
  });
});
