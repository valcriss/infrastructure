import { describe, expect, it } from "vitest";
import { compareWithObserved, declaredServices, detectVariableReferences } from "./compose-analyze.js";

const COMPOSE = `services:
  web:
    image: nginx
    ports:
      - "\${PUBLIC_PORT:-8080}:80"
      - "127.0.0.1:9000:90/tcp"
  db:
    image: postgres
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      NOTE: "prix $$5"
      MODE: \${MODE:-prod}
      OPT: \${OPT:?doit être défini}
    volumes:
      - db-data:/var/lib/postgresql/data
      - type: bind
        source: ./conf
        target: /etc/conf
`;

describe("detectVariableReferences", () => {
  const refs = detectVariableReferences(COMPOSE);
  const get = (n: string) => refs.find((r) => r.name === n);

  it("distingue obligatoires et valeurs par défaut, par service", () => {
    expect(get("PUBLIC_PORT")).toMatchObject({ required: false, defaultValue: "8080", services: ["web"] });
    expect(get("MODE")).toMatchObject({ required: false, defaultValue: "prod" });
    expect(get("DB_PASSWORD")).toMatchObject({ required: true, services: ["db"] });
    expect(get("OPT")?.required).toBe(true);
  });

  it("marque les secrets probables et ignore $$", () => {
    expect(get("DB_PASSWORD")?.secret).toBe(true);
    expect(get("MODE")?.secret).toBe(false);
    expect(refs.find((r) => r.name === "5")).toBeUndefined();
  });

  it("renvoie une liste vide pour un YAML invalide", () => {
    expect(detectVariableReferences("services: [")).toEqual([]);
  });
});

describe("declaredServices", () => {
  it("résout les ports avec défaut ou valeur saisie, et liste les montages", () => {
    const [web, db] = declaredServices(COMPOSE);
    expect(web?.published).toEqual([8080, 9000]);
    expect(declaredServices(COMPOSE, { PUBLIC_PORT: "80" })[0]?.published).toEqual([80, 9000]);
    expect(db?.mounts).toEqual(["/var/lib/postgresql/data", "/etc/conf"]);
  });

  it("signale les ports dépendant d'une variable sans valeur", () => {
    const s = declaredServices('services:\n  a:\n    image: x\n    ports:\n      - "${P}:80"\n');
    expect(s[0]?.unresolved).toBe(true);
  });
});

describe("compareWithObserved", () => {
  const observed = [
    { service: "web", ports: [{ publicPort: 8080 }, { publicPort: 8443 }], mounts: [] },
    { service: "db", mounts: [{ type: "volume", destination: "/var/lib/postgresql/data" }, { type: "bind", destination: "/backup" }] },
    { service: "cache", ports: [] },
  ];
  const diffs = compareWithObserved(COMPOSE, observed);
  const texts = diffs.map((d) => d.message).join("\n");

  it("signale le service observé absent du Compose", () => {
    expect(texts).toContain("« cache »");
  });
  it("signale un port publié non déclaré et un port déclaré non publié", () => {
    expect(texts).toContain("8443");
    expect(texts).toContain("9000");
  });
  it("signale un montage non déclaré mais pas celui qui l'est", () => {
    expect(texts).toContain("/backup");
    expect(texts).not.toContain("postgresql/data présent");
  });
  it("ne signale rien quand tout concorde", () => {
    const ok = compareWithObserved("services:\n  a:\n    image: x\n    ports:\n      - '80:80'\n", [{ service: "a", ports: [{ publicPort: 80 }] }]);
    expect(ok).toEqual([]);
  });
  it("signale un service déclaré sans conteneur, sauf sous profile", () => {
    const d = compareWithObserved("services:\n  a:\n    image: x\n  b:\n    image: y\n    profiles: [debug]\n", [{ service: "a" }]);
    expect(d).toEqual([]);
    expect(compareWithObserved("services:\n  a:\n    image: x\n", []).length).toBe(1);
  });
});
