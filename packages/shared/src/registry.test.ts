import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { validateCompose } from "./compose.js";
import { generateRegistry, REGISTRY_AUTH_FILE, REGISTRY_IMAGE, validateHtpasswdLine, validateRegistryOptions, type RegistryOptions } from "./registry.js";
import { validateFilePath } from "./stack.js";

const HASH = `infrastructure:$2b$10$${"a".repeat(53)}`;
const base: RegistryOptions = { host: "registry.exemple.fr", traefik: { entryPoint: "websecure", certResolver: "letsencrypt", network: "traefik-public" } };

describe("generateRegistry", () => {
  it("produit un Compose valide avec l'image fixée, le volume nommé et le dossier d'authentification en lecture seule", () => {
    const g = generateRegistry(base, HASH);
    expect(validateCompose(g.compose)).toMatchObject({ ok: true });
    const c = parse(g.compose) as Record<string, any>;
    expect(c.services.registry.image).toBe(REGISTRY_IMAGE);
    expect(REGISTRY_IMAGE).not.toMatch(/latest/);
    expect(c.services.registry.volumes).toEqual(["registry-data:/var/lib/registry", "./auth:/auth:ro"]);
    expect(c.services.registry.ports).toBeUndefined();
    expect(c.volumes).toHaveProperty("registry-data");
  });

  it("active l'authentification htpasswd du registre", () => {
    const env = (parse(generateRegistry(base, HASH).compose) as Record<string, any>).services.registry.environment;
    expect(env).toMatchObject({ REGISTRY_AUTH: "htpasswd", REGISTRY_AUTH_HTPASSWD_PATH: "/auth/htpasswd" });
  });

  it("se raccorde au réseau et aux réglages de Traefik par des labels", () => {
    const c = parse(generateRegistry(base, HASH).compose) as Record<string, any>;
    const l = c.services.registry.labels as Record<string, string>;
    expect(l["traefik.enable"]).toBe("true");
    expect(l["traefik.docker.network"]).toBe("traefik-public");
    expect(l["traefik.http.routers.registry.rule"]).toBe("Host(`registry.exemple.fr`)");
    expect(l["traefik.http.routers.registry.entrypoints"]).toBe("websecure");
    expect(l["traefik.http.routers.registry.tls.certresolver"]).toBe("letsencrypt");
    expect(l["traefik.http.services.registry.loadbalancer.server.port"]).toBe("5000");
    expect(c.networks.proxy).toEqual({ name: "traefik-public", external: true });
  });

  it("écrit la ligne htpasswd dans un fichier accepté par la console", () => {
    const g = generateRegistry(base, HASH);
    expect(Object.keys(g.files)).toEqual([REGISTRY_AUTH_FILE]);
    expect(validateFilePath(REGISTRY_AUTH_FILE)).toBeNull();
    expect(g.files[REGISTRY_AUTH_FILE]).toBe(`${HASH}\n`);
  });

  it("refuse un nom de domaine ou des réglages Traefik invalides", () => {
    expect(validateRegistryOptions({ ...base, host: "registre" })).not.toBeNull();
    expect(validateRegistryOptions({ ...base, host: " registry.exemple.fr" })).not.toBeNull();
    expect(validateRegistryOptions({ ...base, host: "a.fr,b.fr" })).not.toBeNull();
    expect(validateRegistryOptions({ ...base, traefik: { ...base.traefik, network: "x y" } })).not.toBeNull();
    expect(() => generateRegistry({ ...base, host: "registre" }, HASH)).toThrow();
  });

  it("n'accepte qu'une empreinte bcrypt du compte unique", () => {
    expect(validateHtpasswdLine(HASH)).toBe(true);
    expect(validateHtpasswdLine(`autre:$2b$10$${"a".repeat(53)}`)).toBe(false);
    expect(validateHtpasswdLine("infrastructure:motdepasse")).toBe(false);
    expect(validateHtpasswdLine(`${HASH}\nautre:x`)).toBe(false);
    expect(() => generateRegistry(base, "infrastructure:motdepasse")).toThrow();
  });
});
