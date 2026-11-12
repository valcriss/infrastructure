import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateCompose } from "./compose.js";
import { generateRegistry, REGISTRY_AUTH_FILE, REGISTRY_IMAGE, validateHtpasswdLine, validateRegistryOptions, type RegistryAccounts, type RegistryOptions } from "./registry.js";
import { validateFilePath } from "./stack.js";

const HASH = `infrastructure:$2a$10$${"a".repeat(53)}`;
const PULL = `infrastructure-pull:$2a$10$${"b".repeat(53)}`;
const ACCOUNTS: RegistryAccounts = { publish: HASH, pull: PULL };
const base: RegistryOptions = { host: "registry.exemple.fr", traefik: { entryPoint: "websecure", certResolver: "letsencrypt", network: "traefik-public" } };

describe("generateRegistry", () => {
  it("produit un Compose valide avec l'image fixée, le volume nommé et le dossier d'authentification en lecture seule", () => {
    const g = generateRegistry(base, ACCOUNTS);
    expect(validateCompose(g.compose)).toMatchObject({ ok: true });
    const c = parse(g.compose) as Record<string, any>;
    expect(c.services.registry.image).toBe(REGISTRY_IMAGE);
    expect(REGISTRY_IMAGE).not.toMatch(/latest/);
    expect(c.services.registry.volumes).toEqual(["registry-data:/var/lib/registry", "./auth:/auth:ro"]);
    expect(c.services.registry.ports).toBeUndefined();
    expect(c.volumes).toHaveProperty("registry-data");
  });

  it("active l'authentification htpasswd du registre", () => {
    const env = (parse(generateRegistry(base, ACCOUNTS).compose) as Record<string, any>).services.registry.environment;
    expect(env).toMatchObject({ REGISTRY_AUTH: "htpasswd", REGISTRY_AUTH_HTPASSWD_PATH: "/auth/htpasswd" });
  });

  it("se raccorde au réseau et aux réglages de Traefik par des labels", () => {
    const c = parse(generateRegistry(base, ACCOUNTS).compose) as Record<string, any>;
    const l = c.services.registry.labels as Record<string, string>;
    expect(l["traefik.enable"]).toBe("true");
    expect(l["traefik.docker.network"]).toBe("traefik-public");
    expect(l["traefik.http.routers.registry.rule"]).toBe("Host(`registry.exemple.fr`)");
    expect(l["traefik.http.routers.registry.entrypoints"]).toBe("websecure");
    expect(l["traefik.http.routers.registry.tls.certresolver"]).toBe("letsencrypt");
    expect(l["traefik.http.services.registry.loadbalancer.server.port"]).toBe("5000");
    expect(c.networks.proxy).toEqual({ name: "traefik-public", external: true });
  });

  it("réserve l'écriture au compte de publication par un second routeur Traefik", () => {
    const l = (parse(generateRegistry(base, ACCOUNTS).compose) as Record<string, any>).services.registry.labels as Record<string, string>;
    // Toute méthode sauf GET et HEAD (refus par défaut des méthodes inattendues), prioritaire sur le routeur de lecture.
    expect(l["traefik.http.routers.registry-write.rule"]).toBe("Host(`registry.exemple.fr`) && !Method(`GET`) && !Method(`HEAD`)");
    expect(Number(l["traefik.http.routers.registry-write.priority"])).toBeGreaterThan(0);
    expect(l["traefik.http.routers.registry-write.middlewares"]).toBe("registry-write-auth");
    expect(l["traefik.http.routers.registry-write.entrypoints"]).toBe("websecure");
    expect(l["traefik.http.routers.registry-write.tls.certresolver"]).toBe("letsencrypt");
    expect(l["traefik.http.routers.registry-write.service"]).toBe("registry");
    expect(l["traefik.http.routers.registry.service"]).toBe("registry");
  });

  it("ne met dans Traefik que l'empreinte du compte de publication, avec « $ » échappé pour Compose", () => {
    const g = generateRegistry(base, ACCOUNTS);
    const l = (parse(g.compose) as Record<string, any>).services.registry.labels as Record<string, string>;
    const users = l["traefik.http.middlewares.registry-write-auth.basicauth.users"] as string;
    expect(users).toBe(`infrastructure:$$2a$$10$$${"a".repeat(53)}`);
    // Compose remplace « $$ » par « $ » : Traefik reçoit l'empreinte telle qu'écrite dans htpasswd.
    expect(users.replaceAll("$$", "$")).toBe(HASH);
    expect(g.compose).not.toContain(PULL.split(":")[1]);
    expect(g.compose).not.toContain("infrastructure-pull");
  });

  it("écrit les deux comptes dans un fichier accepté par la console", () => {
    const g = generateRegistry(base, ACCOUNTS);
    expect(Object.keys(g.files)).toEqual([REGISTRY_AUTH_FILE]);
    expect(validateFilePath(REGISTRY_AUTH_FILE)).toBeNull();
    expect(g.files[REGISTRY_AUTH_FILE]).toBe(`${HASH}\n${PULL}\n`);
  });

  it("refuse un nom de domaine ou des réglages Traefik invalides", () => {
    expect(validateRegistryOptions({ ...base, host: "registre" })).not.toBeNull();
    expect(validateRegistryOptions({ ...base, host: " registry.exemple.fr" })).not.toBeNull();
    expect(validateRegistryOptions({ ...base, host: "a.fr,b.fr" })).not.toBeNull();
    expect(validateRegistryOptions({ ...base, traefik: { ...base.traefik, network: "x y" } })).not.toBeNull();
    expect(() => generateRegistry({ ...base, host: "registre" }, ACCOUNTS)).toThrow();
  });

  it("n'accepte qu'une empreinte bcrypt pour chacun des deux comptes", () => {
    expect(validateHtpasswdLine(HASH)).toBe(true);
    expect(validateHtpasswdLine(PULL, "infrastructure-pull")).toBe(true);
    expect(validateHtpasswdLine(PULL)).toBe(false);
    expect(validateHtpasswdLine(`autre:$2b$10$${"a".repeat(53)}`)).toBe(false);
    expect(validateHtpasswdLine("infrastructure:motdepasse")).toBe(false);
    expect(validateHtpasswdLine(`${HASH}\nautre:x`)).toBe(false);
    expect(() => generateRegistry(base, { publish: "infrastructure:motdepasse", pull: PULL })).toThrow();
    // Les comptes ne se permutent pas.
    expect(() => generateRegistry(base, { publish: PULL, pull: HASH })).toThrow();
  });
});

describe("healthcheck du registre", () => {
  it("déclare le healthcheck sur le serveur de diagnostic, lié à la boucle locale du conteneur", () => {
    const g = generateRegistry(base, ACCOUNTS);
    expect(validateCompose(g.compose)).toMatchObject({ ok: true });
    const svc = (parse(g.compose) as Record<string, any>).services.registry;
    expect(svc.healthcheck).toMatchObject({ test: ["CMD-SHELL", "wget -q --spider http://127.0.0.1:5001/debug/health"], interval: "30s", retries: 3, start_period: "15s" });
    expect(svc.environment.REGISTRY_HTTP_DEBUG_ADDR).toBe("127.0.0.1:5001");
    expect(svc.ports).toBeUndefined();
  });
});
