import { describe, expect, it } from "vitest";
import { encodeDotenv, encodeDotenvExport } from "./dotenv.js";

describe("encodeDotenvExport", () => {
  it("encode comme l'agent et laisse vides, avec un commentaire, les variables sensibles non exportées", () => {
    const out = encodeDotenvExport(
      [
        { name: "B", value: "it's $HOME" },
        { name: "A", value: "simple" },
        { name: "SECRET_TOKEN", value: null },
      ],
      "# entête",
    );
    expect(out).toBe(["# entête", "A='simple'", 'B="it\'s \\$HOME"', "# SECRET_TOKEN : valeur sensible non exportée, à renseigner", "SECRET_TOKEN=", ""].join("\n"));
    // Même encodage des valeurs que le `.env` écrit par l'agent à chaque déploiement.
    expect(out).toContain(encodeDotenv({ A: "simple" }).split("\n")[1]);
  });

  it("refuse un nom ou une valeur invalide", () => {
    expect(() => encodeDotenvExport([{ name: "1BAD", value: "x" }], "#")).toThrow();
    expect(() => encodeDotenvExport([{ name: "OK", value: "a\nb" }], "#")).toThrow();
  });
});
