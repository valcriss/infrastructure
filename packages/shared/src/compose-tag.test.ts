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
