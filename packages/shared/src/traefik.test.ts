import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateCompose } from "./compose.js";
import { validateFilePath } from "./stack.js";
import { generateTraefik, TRAEFIK_DEFAULTS, TRAEFIK_DYNAMIC_FILE, TRAEFIK_IMAGE, TRAEFIK_STATIC_FILE, validateTraefikOptions, type TraefikOptions } from "./traefik.js";

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
