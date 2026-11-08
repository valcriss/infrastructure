import { describe, expect, it } from "vitest";
import { ComposeEditError } from "./compose-edit.js";
import { cleanCompose } from "./compose-clean.js";
import { validateCompose } from "./compose.js";

const SAMPLE = `# en-tête
version: "3.8"

services:

  ghost:
    image: ghost:6.75.0-alpine # tag figé
    restart: always
    environment:
      # voir la doc
      database__client: mysql
      url: \${URL}
      #NODE_ENV: development
    networks:
      - shared_network
  db:
    image: mysql:8.0
    command: ["--default-authentication-plugin=mysql_native_password", "--max-connections=500"]
networks:
  shared_network:
    external: true
volumes:
  data: {}
`;

describe("cleanCompose", () => {
  const r = cleanCompose(SAMPLE);

  it("supprime les commentaires et compte ceux retirés", () => {
    expect(r.compose).not.toContain("#");
    expect(r.comments).toBe(4);
  });

  it("supprime la directive version", () => {
    expect(r.compose).not.toMatch(/^version:/m);
    expect(r.versionRemoved).toBe("3.8");
  });

  it("met une ligne vide entre sections et entre services, sans autre ligne vide", () => {
    expect(r.compose).toBe(`services:
  ghost:
    image: ghost:6.75.0-alpine
    restart: always
    environment:
      database__client: mysql
      url: \${URL}
    networks:
      - shared_network

  db:
    image: mysql:8.0
    command: ["--default-authentication-plugin=mysql_native_password", "--max-connections=500"]

networks:
  shared_network:
    external: true

volumes:
  data: {}
`);
  });

  it("donne un Compose toujours valide, avec les mêmes services", () => {
    const v = validateCompose(r.compose);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.services).toEqual(["ghost", "db"]);
  });

  it("est idempotent", () => {
    const again = cleanCompose(r.compose);
    expect(again.compose).toBe(r.compose);
    expect(again.changed).toBe(false);
    expect(again.comments).toBe(0);
    expect(again.versionRemoved).toBeNull();
  });

  it("conserve les guillemets et l'indentation de 4 espaces", () => {
    const out = cleanCompose('services:\n    web:\n        image: "nginx:1"\n        ports:\n            - "80:80"\n').compose;
    expect(out).toContain('        image: "nginx:1"');
    expect(out).toContain('            - "80:80"');
  });

  it("refuse un YAML invalide", () => {
    expect(() => cleanCompose("services: [")).toThrow(ComposeEditError);
  });
});
