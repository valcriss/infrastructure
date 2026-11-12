import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateCompose } from "./compose.js";
import { validateFilePath } from "./stack.js";
import { addTraefikHealthcheck, generateTraefik, TRAEFIK_DEFAULTS, TRAEFIK_DYNAMIC_FILE, TRAEFIK_IMAGE, TRAEFIK_STATIC_FILE, validateTraefikOptions, type TraefikOptions } from "./traefik.js";

const base: TraefikOptions = { ...TRAEFIK_DEFAULTS, email: "admin@exemple.fr" };
const staticOf = (o: TraefikOptions) => parse(generateTraefik(o).files[TRAEFIK_STATIC_FILE] as string) as Record<string, any>;

describe("generateTraefik", () => {
  it("produit un Compose valide pour la console, avec l'image fixée et le dossier dynamique monté", () => {
    const g = generateTraefik(base);
    expect(validateCompose(g.compose)).toMatchObject({ ok: true });
    const c = parse(g.compose) as Record<string, any>;
    expect(c.services.traefik.image).toBe(TRAEFIK_IMAGE);
    expect(TRAEFIK_IMAGE).not.toMatch(/latest/);
    expect(c.services.traefik.ports).toEqual(["80:80", "443:443"]);
    expect(c.services.traefik.volumes).toEqual(
      expect.arrayContaining(["/var/run/docker.sock:/var/run/docker.sock:ro", "./traefik.yml:/etc/traefik/traefik.yml:ro", "./dynamic:/etc/traefik/dynamic:ro", "traefik-acme:/acme"]),
    );
    expect(c.volumes).toHaveProperty("traefik-acme");
  });

  it("les chemins des fichiers sont acceptés par la console", () => {
    for (const p of Object.keys(generateTraefik(base).files)) expect(validateFilePath(p)).toBeNull();
    expect(Object.keys(generateTraefik(base).files).sort()).toEqual([TRAEFIK_DYNAMIC_FILE, TRAEFIK_STATIC_FILE].sort());
  });

  it("crée le réseau avec un nom fixe, ou déclare un réseau existant en externe", () => {
    const created = parse(generateTraefik(base).compose) as Record<string, any>;
    expect(created.networks.proxy).toEqual({ name: "traefik-public" });
    const existing = parse(generateTraefik({ ...base, network: { mode: "existing", name: "proxy-prod" } }).compose) as Record<string, any>;
    expect(existing.networks.proxy).toEqual({ name: "proxy-prod", external: true });
    expect(staticOf({ ...base, network: { mode: "existing", name: "proxy-prod" } }).providers.docker.network).toBe("proxy-prod");
  });

  it("configure les entrypoints, la redirection HTTPS et le résolveur avec les noms choisis", () => {
    const s = staticOf({ ...base, httpEntryPoint: "http", httpsEntryPoint: "https", certResolver: "le" });
    expect(Object.keys(s.entryPoints)).toEqual(["http", "https"]);
    expect(s.entryPoints.http.http.redirections.entryPoint).toEqual({ to: "https", scheme: "https" });
    expect(s.entryPoints.https.http.tls.certResolver).toBe("le");
    expect(s.certificatesResolvers.le.acme).toMatchObject({ email: "admin@exemple.fr", storage: "/acme/acme.json", httpChallenge: { entryPoint: "http" } });
  });

  it("utilise l'autorité de test par défaut et la production à la demande", () => {
    expect(staticOf(base).certificatesResolvers.letsencrypt.acme.caServer).toContain("staging");
    expect(staticOf({ ...base, production: true }).certificatesResolvers.letsencrypt.acme).not.toHaveProperty("caServer");
  });

  it("supprime les en-têtes qui en imitent un autre sur les deux entrypoints, sans perdre la redirection ni le TLS", () => {
    const s = staticOf({ ...base, httpEntryPoint: "http", httpsEntryPoint: "https" });
    expect(s.entryPoints.http.http.aliasHeadersStrategy).toBe("delete");
    expect(s.entryPoints.https.http.aliasHeadersStrategy).toBe("delete");
    expect(s.entryPoints.http.http.redirections.entryPoint.to).toBe("https");
    expect(s.entryPoints.https.http.tls.certResolver).toBe("letsencrypt");
  });

  it("garde le tableau de bord désactivé, n'expose rien par défaut et recharge le dossier dynamique", () => {
    const s = staticOf(base);
    expect(s.api.dashboard).toBe(false);
    expect(s.providers.docker.exposedByDefault).toBe(false);
    expect(s.providers.file).toEqual({ directory: "/etc/traefik/dynamic", watch: true });
    expect(parse(generateTraefik(base).files[TRAEFIK_DYNAMIC_FILE] as string)).toEqual({ tls: { options: { default: { minVersion: "VersionTLS12" } } } });
  });

  it("ne laisse pas une adresse e-mail casser le YAML", () => {
    const s = staticOf({ ...base, email: "a+b@sous.exemple.fr" });
    expect(s.certificatesResolvers.letsencrypt.acme.email).toBe("a+b@sous.exemple.fr");
  });

  it("refuse de générer avec des options invalides", () => {
    expect(() => generateTraefik({ ...base, email: "pas-un-mail" })).toThrow(/e-mail/);
  });
});

describe("validateTraefikOptions", () => {
  it("accepte les valeurs par défaut avec un e-mail", () => {
    expect(validateTraefikOptions(base)).toBeNull();
  });

  it.each([
    ["e-mail vide", { email: "" }, /e-mail/],
    ["e-mail avec guillemet", { email: 'a"b@exemple.fr' }, /e-mail/],
    ["entrypoint avec espace", { httpEntryPoint: "mon web" }, /Entrypoint HTTP/],
    ["entrypoint injectant du YAML", { httpsEntryPoint: "web\n  evil: 1" }, /Entrypoint HTTPS/],
    ["résolveur vide", { certResolver: "" }, /Résolveur/],
    ["entrypoints identiques", { httpsEntryPoint: "web" }, /différents/],
    ["réseau prédéfini", { network: { mode: "create", name: "bridge" } }, /prédéfini/],
    ["réseau invalide", { network: { mode: "create", name: "../x" } }, /Réseau/],
  ] as const)("refuse : %s", (_label, over, message) => {
    expect(validateTraefikOptions({ ...base, ...over } as TraefikOptions)).toMatch(message);
  });
});

describe("healthcheck de Traefik", () => {
  it("le Compose généré déclare le healthcheck et le fichier statique active /ping", () => {
    const g = generateTraefik(base);
    const c = parse(g.compose) as Record<string, any>;
    expect(c.services.traefik.healthcheck).toMatchObject({ test: ["CMD-SHELL", "traefik healthcheck --ping"], interval: "30s", retries: 3, start_period: "15s" });
    expect(validateCompose(g.compose)).toMatchObject({ ok: true });
    expect(parse(g.files[TRAEFIK_STATIC_FILE] as string).ping).toEqual({});
    // /ping reste sur l'entrypoint interne : aucun entrypoint public ne le porte, et le port 8080 n'est pas publié.
    expect(c.services.traefik.ports).toEqual(["80:80", "443:443"]);
  });

  const legacy = () => {
    const g = generateTraefik(base);
    return { compose: g.compose.replace(/ {4}healthcheck:\n(?: {6}.*\n)+/, ""), staticConfig: (g.files[TRAEFIK_STATIC_FILE] as string).replace(/\n# Point de contrôle[\s\S]*?ping: \{\}\n/, "\n") };
  };

  it("ajoute le healthcheck et « ping » à une application ancienne, en conservant le reste", () => {
    const { compose, staticConfig } = legacy();
    expect(compose).not.toContain("healthcheck");
    expect(staticConfig).not.toContain("ping");
    const p = addTraefikHealthcheck(compose.replace("restart: unless-stopped", "restart: always # choix manuel"), staticConfig + "# réglage manuel\n");
    expect(p.changed).toBe(true);
    expect(p.notes).toEqual([]);
    expect((parse(p.compose) as any).services.traefik.healthcheck.test).toEqual(["CMD-SHELL", "traefik healthcheck --ping"]);
    expect(p.compose).toContain("restart: always # choix manuel");
    expect(parse(p.staticConfig as string).ping).toEqual({});
    expect(p.staticConfig).toContain("# réglage manuel");
    expect(p.staticConfig).toContain("certResolver: letsencrypt");
  });

  it("est sans effet sur une application déjà à jour, et ne remplace pas un réglage existant", () => {
    const g = generateTraefik(base);
    const same = addTraefikHealthcheck(g.compose, g.files[TRAEFIK_STATIC_FILE] as string);
    expect(same.changed).toBe(false);
    const custom = g.compose.replace("traefik healthcheck --ping", "mon-test");
    expect(addTraefikHealthcheck(custom, g.files[TRAEFIK_STATIC_FILE] as string).compose).toContain("mon-test");
  });

  it("n'ajoute pas le healthcheck sans pouvoir ajouter « ping » (le conteneur serait « unhealthy »)", () => {
    const { compose } = legacy();
    const absent = addTraefikHealthcheck(compose, null);
    expect(absent.compose).toBe(compose);
    expect(absent.changed).toBe(false);
    expect(absent.notes.join(" ")).toContain("ping");
    const broken = addTraefikHealthcheck(compose, "- pas\n- un mapping\n");
    expect(broken.compose).toBe(compose);
    expect(broken.changed).toBe(false);
  });
});
