import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ComposeEditError } from "./compose-edit.js";
import { validateCompose } from "./compose.js";
import { editServiceTraefik, readServiceTraefik, traefikConsoleSnippet, traefikRouterName, validateTraefikExposure, type TraefikContext, type TraefikExposure } from "./compose-traefik.js";

const ctx: TraefikContext = { routerName: "blog-web", entryPoint: "websecure", certResolver: "letsencrypt", network: "traefik-public" };
const expo: TraefikExposure = { hosts: ["blog.exemple.fr"], port: 2368, middlewares: [] };
const docOf = (t: string) => parse(t) as Record<string, any>;

const SIMPLE = `services:
  web:
    image: ghost:5
    restart: unless-stopped
  db:
    image: mysql:8
`;

describe("editServiceTraefik : ajout", () => {
  it("écrit les labels du routeur, rattache le service au réseau de Traefik et garde le réseau implicite", () => {
    const out = editServiceTraefik(SIMPLE, "web", ctx, expo);
    const d = docOf(out);
    expect(d.services.web.labels).toEqual({
      "traefik.enable": "true",
      "traefik.docker.network": "traefik-public",
      "traefik.http.routers.blog-web.rule": "Host(`blog.exemple.fr`)",
      "traefik.http.routers.blog-web.entrypoints": "websecure",
      "traefik.http.routers.blog-web.tls": "true",
      "traefik.http.routers.blog-web.tls.certresolver": "letsencrypt",
      "traefik.http.services.blog-web.loadbalancer.server.port": "2368",
    });
    // Sans « networks », le service n'était que sur le réseau du projet : il doit y rester.
    expect(d.services.web.networks).toEqual(["default", "traefik-public"]);
    expect(d.services.db.networks).toBeUndefined();
    expect(d.networks).toEqual({ "traefik-public": { name: "traefik-public", external: true } });
    expect(validateCompose(out)).toMatchObject({ ok: true });
  });

  it("gère plusieurs domaines et des middlewares", () => {
    const out = editServiceTraefik(SIMPLE, "web", ctx, { hosts: ["a.exemple.fr", "b.exemple.fr"], port: 80, middlewares: ["auth@file", "securite"] });
    const l = docOf(out).services.web.labels;
    expect(l["traefik.http.routers.blog-web.rule"]).toBe("Host(`a.exemple.fr`) || Host(`b.exemple.fr`)");
    expect(l["traefik.http.routers.blog-web.middlewares"]).toBe("auth@file,securite");
  });

  it("conserve commentaires, autres labels et réseaux existants (liste)", () => {
    const text = `# Mon blog
services:
  web:
    image: ghost:5
    # étiquettes à moi
    labels:
      com.exemple.owner: equipe-a
      traefik.http.routers.autre.rule: Host(\`autre.exemple.fr\`)
    networks:
      - interne
networks:
  interne: {}
`;
    const out = editServiceTraefik(text, "web", ctx, expo);
    expect(out).toContain("# Mon blog");
    expect(out).toContain("# étiquettes à moi");
    const d = docOf(out);
    expect(d.services.web.labels["com.exemple.owner"]).toBe("equipe-a");
    expect(d.services.web.labels["traefik.http.routers.autre.rule"]).toBe("Host(`autre.exemple.fr`)");
    expect(d.services.web.networks).toEqual(["interne", "traefik-public"]);
    expect(d.networks.interne).toEqual({});
  });

  it("accepte les labels en liste « clé=valeur » et les réseaux en mapping", () => {
    const text = `services:
  web:
    image: ghost:5
    labels:
      - com.exemple.owner=equipe-a
    networks:
      interne:
        aliases: [blog]
networks:
  interne: {}
`;
    const d = docOf(editServiceTraefik(text, "web", ctx, expo));
    expect(d.services.web.labels).toContain("com.exemple.owner=equipe-a");
    expect(d.services.web.labels).toContain("traefik.http.routers.blog-web.rule=Host(`blog.exemple.fr`)");
    expect(d.services.web.labels).toContain("traefik.enable=true");
    expect(d.services.web.networks.interne).toEqual({ aliases: ["blog"] });
    expect(d.services.web.networks["traefik-public"]).toEqual({});
  });

  it("réutilise un réseau déjà déclaré en externe (même sous une autre clé) sans le redéclarer", () => {
    const text = `services:
  web:
    image: ghost:5
networks:
  proxy:
    name: traefik-public
    external: true
`;
    const d = docOf(editServiceTraefik(text, "web", ctx, expo));
    expect(d.networks).toEqual({ proxy: { name: "traefik-public", external: true } });
    expect(d.services.web.networks).toEqual(["default", "proxy"]);
  });

  it("remplace l'exposition précédente du même routeur sans toucher aux autres routeurs", () => {
    const first = editServiceTraefik(SIMPLE, "web", ctx, { ...expo, middlewares: ["auth@file"] });
    const second = editServiceTraefik(first, "web", ctx, { hosts: ["nouveau.exemple.fr"], port: 3000, middlewares: [] });
    const l = docOf(second).services.web.labels;
    expect(l["traefik.http.routers.blog-web.rule"]).toBe("Host(`nouveau.exemple.fr`)");
    expect(l["traefik.http.routers.blog-web.middlewares"]).toBeUndefined();
    expect(l["traefik.http.services.blog-web.loadbalancer.server.port"]).toBe("3000");
    expect(Object.keys(l).filter((k) => k.startsWith("traefik.http.routers.blog-web."))).toHaveLength(4);
    // Idempotent.
    expect(editServiceTraefik(second, "web", ctx, { hosts: ["nouveau.exemple.fr"], port: 3000, middlewares: [] })).toBe(second);
    expect(docOf(second).services.web.networks).toEqual(["default", "traefik-public"]);
  });
});

describe("editServiceTraefik : retrait", () => {
  it("retire les labels du routeur et supprime « labels » devenu vide", () => {
    const exposed = editServiceTraefik(SIMPLE, "web", ctx, expo);
    const removed = docOf(editServiceTraefik(exposed, "web", ctx, null));
    expect(removed.services.web.labels).toBeUndefined();
  });

  it("garde « traefik.enable » tant qu'un autre routeur existe, et les labels étrangers", () => {
    const text = `services:
  web:
    image: ghost:5
    labels:
      com.exemple.owner: equipe-a
      traefik.enable: "true"
      traefik.http.routers.admin.rule: Host(\`admin.exemple.fr\`)
`;
    const exposed = editServiceTraefik(text, "web", ctx, expo);
    const l = docOf(editServiceTraefik(exposed, "web", ctx, null)).services.web.labels;
    expect(l).toEqual({ "com.exemple.owner": "equipe-a", "traefik.enable": "true", "traefik.http.routers.admin.rule": "Host(`admin.exemple.fr`)", "traefik.docker.network": "traefik-public" });
  });

  it("retire aussi « traefik.enable » quand il ne reste aucun routeur, et ne fait rien sans labels", () => {
    const text = `services:
  web:
    image: ghost:5
    labels:
      com.exemple.owner: equipe-a
`;
    const exposed = editServiceTraefik(text, "web", ctx, expo);
    expect(docOf(editServiceTraefik(exposed, "web", ctx, null)).services.web.labels).toEqual({ "com.exemple.owner": "equipe-a" });
    expect(editServiceTraefik(SIMPLE, "web", ctx, null)).toBe(SIMPLE);
  });

  it("retire dans une liste de labels", () => {
    const text = `services:
  web:
    image: ghost:5
    labels:
      - com.exemple.owner=equipe-a
`;
    const exposed = editServiceTraefik(text, "web", ctx, expo);
    expect(docOf(editServiceTraefik(exposed, "web", ctx, null)).services.web.labels).toEqual(["com.exemple.owner=equipe-a"]);
  });
});

describe("editServiceTraefik : refus", () => {
  const refuse = (text: string, service = "web", e: TraefikExposure | null = expo): string => {
    try {
      editServiceTraefik(text, service, ctx, e);
    } catch (err) {
      expect(err).toBeInstanceOf(ComposeEditError);
      return (err as ComposeEditError).code + ":" + (err as ComposeEditError).message;
    }
    throw new Error("aurait dû être refusé");
  };

  it("refuse un service inconnu, un YAML invalide, une clé de fusion et network_mode", () => {
    expect(refuse(SIMPLE, "absent")).toMatch(/^service_not_found/);
    expect(refuse("services: [")).toMatch(/YAML valide/);
    expect(refuse("services:\n  web:\n    <<: *base\n    image: x\n")).toMatch(/fusion/);
    expect(refuse("services:\n  web:\n    image: x\n    network_mode: host\n")).toMatch(/network_mode/);
  });

  it("refuse les alias sur labels et networks", () => {
    expect(refuse("x-l: &l\n  a: b\nservices:\n  web:\n    image: x\n    labels: *l\n")).toMatch(/alias/);
    expect(refuse("x-n: &n\n  - a\nservices:\n  web:\n    image: x\n    networks: *n\n")).toMatch(/alias/);
  });

  it("refuse un réseau déclaré sans « external » ou avec une autre définition", () => {
    expect(refuse("services:\n  web:\n    image: x\nnetworks:\n  traefik-public:\n    driver: bridge\n")).toMatch(/external/);
    expect(refuse("services:\n  web:\n    image: x\nnetworks:\n  proxy:\n    name: traefik-public\n")).toMatch(/external/);
  });

  it("refuse une exposition invalide", () => {
    expect(refuse(SIMPLE, "web", { hosts: [], port: 80, middlewares: [] })).toMatch(/domaine/);
    expect(refuse(SIMPLE, "web", { hosts: ["Mauvais Domaine"], port: 80, middlewares: [] })).toMatch(/invalide/);
  });
});

describe("readServiceTraefik", () => {
  it("relit ce que la console a écrit", () => {
    const text = editServiceTraefik(SIMPLE, "web", ctx, { hosts: ["a.exemple.fr", "b.exemple.fr"], port: 2368, middlewares: ["auth@file"] });
    expect(readServiceTraefik(text, "web", ctx.routerName)).toEqual({
      exposure: { hosts: ["a.exemple.fr", "b.exemple.fr"], port: 2368, middlewares: ["auth@file"] },
      entryPoint: "websecure",
      certResolver: "letsencrypt",
      network: "traefik-public",
      customRule: false,
    });
  });

  it("signale une règle écrite à la main et lit les labels en liste", () => {
    const text = "services:\n  web:\n    image: x\n    labels:\n      - traefik.http.routers.blog-web.rule=Host(`a.exemple.fr`) && PathPrefix(`/blog`)\n";
    expect(readServiceTraefik(text, "web", "blog-web")).toMatchObject({ exposure: { hosts: ["a.exemple.fr"], port: 0 }, customRule: true });
  });

  it("renvoie null sans routeur, service inconnu ou YAML invalide", () => {
    expect(readServiceTraefik(SIMPLE, "web", "blog-web")).toBeNull();
    expect(readServiceTraefik(SIMPLE, "absent", "blog-web")).toBeNull();
    expect(readServiceTraefik("services: [", "web", "blog-web")).toBeNull();
  });
});

describe("traefikRouterName et validateTraefikExposure", () => {
  it("construit un nom de routeur unique et valide", () => {
    expect(traefikRouterName("Mon_Blog", "web.app")).toBe("mon-blog-web-app");
    expect(traefikRouterName("a", "b")).toBe("a-b");
    expect(traefikRouterName("x".repeat(60), "y".repeat(60))).toHaveLength(63);
  });

  it("valide les domaines, le port et les middlewares", () => {
    expect(validateTraefikExposure(expo)).toBeNull();
    expect(validateTraefikExposure({ ...expo, hosts: ["localhost"] })).toMatch(/invalide/);
    expect(validateTraefikExposure({ ...expo, hosts: ["a.fr", "a.fr"] })).toMatch(/répété/);
    expect(validateTraefikExposure({ ...expo, port: 0 })).toMatch(/Port/);
    expect(validateTraefikExposure({ ...expo, port: 70000 })).toMatch(/Port/);
    expect(validateTraefikExposure({ ...expo, middlewares: ["a b"] })).toMatch(/middleware/);
    expect(validateTraefikExposure({ ...expo, hosts: ["a`) || Host(`b.fr"] })).toMatch(/invalide/);
  });
});

describe("traefikConsoleSnippet", () => {
  it("produit un extrait YAML valide avec les cookies sécurisés, les labels et le réseau externe", () => {
    const out = traefikConsoleSnippet({ entryPoint: "websecure", certResolver: "letsencrypt", network: "traefik-public" }, "console.exemple.fr");
    const d = docOf(out);
    expect(d.services.console.environment.SECURE_COOKIES).toBe("true");
    expect(d.services.console.labels["traefik.http.routers.console.rule"]).toBe("Host(`console.exemple.fr`)");
    expect(d.services.console.labels["traefik.http.services.console.loadbalancer.server.port"]).toBe("8080");
    expect(d.services.console.networks).toEqual(["internal", "traefik-public"]);
    expect(d.networks["traefik-public"]).toEqual({ name: "traefik-public", external: true });
    expect(() => traefikConsoleSnippet({ entryPoint: "websecure", certResolver: "le", network: "n" }, "pas un domaine")).toThrow(/invalide/);
  });
});
