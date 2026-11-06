import SwaggerParser from "@apidevtools/swagger-parser";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTE_DOCS, buildOpenApi } from "./openapi.js";

describe("contrat OpenAPI", () => {
  const spec = buildOpenApi() as { paths: Record<string, Record<string, any>>; components: any };

  it("est identique au fichier docs/openapi.json (sinon : npm run build puis npm run openapi -w @infra/console)", () => {
    const committed = readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8");
    expect(committed).toBe(JSON.stringify(spec, null, 2) + "\n");
  });

  it("est un document OpenAPI 3.1 valide", async () => {
    // validate() modifie l'objet : on lui donne une copie.
    await expect(SwaggerParser.validate(structuredClone(spec) as never)).resolves.toBeDefined();
  });

  it("n'a pas de route en double", () => {
    const keys = ROUTE_DOCS.map((d) => `${d.method} ${d.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("déclare chaque paramètre de chemin et une sécurité cohérente", () => {
    for (const d of ROUTE_DOCS) {
      const op = spec.paths[d.path]?.[d.method];
      expect(op, `${d.method} ${d.path}`).toBeDefined();
      const declared = (op.parameters as { name: string; in: string }[]).filter((p) => p.in === "path").map((p) => p.name);
      const inPath = [...d.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(declared).toEqual(inPath);
      if (d.access === "public") expect(op.security).toEqual([]);
      else expect(op.security.length).toBeGreaterThan(0);
    }
  });

  it("génère les corps de requête depuis les schémas réels", () => {
    const create = spec.paths["/api/v1/stacks"]?.post.requestBody.content["application/json"].schema;
    expect(create.type).toBe("object");
    expect(create.properties).toHaveProperty("compose");
    expect(create.properties).toHaveProperty("adopt");
    const vars = spec.paths["/api/v1/stacks/{id}/variables"]?.patch.requestBody.content["application/json"].schema;
    expect(vars.required).toContain("expectedRevision");
  });

  it("fait référence à des schémas existants", () => {
    const text = JSON.stringify(spec);
    for (const m of text.matchAll(/#\/components\/schemas\/(\w+)/g)) {
      expect(spec.components.schemas).toHaveProperty(m[1] as string);
    }
  });
});
