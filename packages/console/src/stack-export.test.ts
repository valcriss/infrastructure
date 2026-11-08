import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildStackExport, type ExportInput } from "./stack-export.js";

const base: ExportInput = {
  stackName: "demo",
  revision: 5,
  deployedAt: new Date("2026-11-08T05:33:00Z"),
  newerRevision: 8,
  exportedBy: "daniel",
  exportedAt: new Date("2026-11-08T10:00:00Z"),
  includeSecrets: false,
  compose: "services:\n  ghost:\n    image: ghost:6\n    environment:\n      PASS: ${DB_PASSWORD}\n",
  variables: { DB_PASSWORD: { value: "s3cret'$x", sensitive: true }, URL: { value: "https://example.com", sensitive: false } },
  files: { "nginx/default.conf": "server {}", "build/ghost/Dockerfile": "FROM ghost:6\n", "certs/key.pem": "-----BEGIN-----" },
  sensitiveFiles: ["certs/key.pem"],
};

const read = (zip: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]));

describe("buildStackExport", () => {
  it("sans secrets : Compose, .env à lignes vides pour le sensible, fichiers non sensibles, LISEZMOI", () => {
    const out = buildStackExport(base);
    expect(out.filename).toBe("demo-r5.zip");
    expect(out.omitted).toEqual({ variables: ["DB_PASSWORD"], files: ["certs/key.pem"] });
    const files = read(out.zip);
    expect(Object.keys(files).sort()).toEqual([".env", "LISEZMOI.txt", "build/ghost/Dockerfile", "docker-compose.yml", "nginx/default.conf"]);
    expect(files["docker-compose.yml"]).toBe(base.compose);
    expect(files[".env"]).toContain("URL='https://example.com'");
    expect(files[".env"]).toContain("DB_PASSWORD=\n");
    expect(files[".env"]).not.toContain("s3cret");
    expect(files["LISEZMOI.txt"]).toContain("Révision exportée : 5");
    expect(files["LISEZMOI.txt"]).toContain("Une révision plus récente (8)");
    expect(files["LISEZMOI.txt"]).toContain("NON exportées");
    expect(files["LISEZMOI.txt"]).toContain("DB_PASSWORD");
    expect(files["LISEZMOI.txt"]).toContain("certs/key.pem");
    expect(files["LISEZMOI.txt"]).toContain("docker compose --project-name demo up -d");
  });

  it("avec secrets : valeurs et fichiers sensibles inclus, avertissement dans le LISEZMOI et dans le nom", () => {
    const out = buildStackExport({ ...base, includeSecrets: true, newerRevision: null });
    expect(out.filename).toBe("demo-r5-avec-secrets.zip");
    expect(out.omitted).toEqual({ variables: [], files: [] });
    const files = read(out.zip);
    expect(files[".env"]).toContain(`DB_PASSWORD="s3cret'\\$x"`);
    expect(files["certs/key.pem"]).toBe("-----BEGIN-----");
    expect(files["LISEZMOI.txt"]).toContain("INCLUSES");
    expect(files["LISEZMOI.txt"]).not.toContain("révision plus récente");
  });
});
