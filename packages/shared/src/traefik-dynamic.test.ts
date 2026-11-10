import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { TRAEFIK_DEFAULTS, TRAEFIK_DYNAMIC_FILE, generateTraefik } from "./traefik.js";
import {
  DynamicEditError,
  editDynamic,
  hasBasicAuth,
  readDynamic,
  validateMiddlewareSpec,
  validateRouteSpec,
  type DynamicChange,
  type DynamicContext,
  type MiddlewareSpec,
  type RouteSpec,
} from "./traefik-dynamic.js";

const ctx: DynamicContext = { entryPoint: "websecure", certResolver: "letsencrypt" };
const GENERATED = generateTraefik({ ...TRAEFIK_DEFAULTS, email: "a@exemple.fr" }).files[TRAEFIK_DYNAMIC_FILE] as string;
const js = (t: string) => parse(t) as Record<string, any>;
const BCRYPT = `admin:$2y$05$${"a".repeat(53)}`;

const edit = (text: string, change: DynamicChange): string => editDynamic(text, change, ctx);
const refuse = (text: string, change: DynamicChange): DynamicEditError => {
  try {
    edit(text, change);
  } catch (err) {
    expect(err).toBeInstanceOf(DynamicEditError);
    return err as DynamicEditError;
  }
  throw new Error("aurait dû être refusé");
};
const route = (over: Partial<RouteSpec> = {}): RouteSpec => ({ hosts: ["nas.exemple.fr"], urls: ["http://10.0.0.5:8080"], middlewares: [], ...over });

describe("editDynamic : middlewares", () => {
  const cases: [string, MiddlewareSpec, Record<string, unknown>][] = [
    ["ipAllowList", { type: "ipAllowList", sourceRange: ["10.0.0.0/8", "192.168.1.5"] }, { ipAllowList: { sourceRange: ["10.0.0.0/8", "192.168.1.5"] } }],
    ["rateLimit", { type: "rateLimit", average: 100, burst: 50 }, { rateLimit: { average: 100, burst: 50 } }],
    ["compress", { type: "compress" }, { compress: {} }],
    ["basicAuth", { type: "basicAuth", users: [BCRYPT] }, { basicAuth: { users: [BCRYPT] } }],
    ["stripPrefix", { type: "stripPrefix", prefixes: ["/api"] }, { stripPrefix: { prefixes: ["/api"] } }],
    [
      "headers",
      { type: "headers", hsts: true, frameDeny: true, contentTypeNosniff: true, referrerPolicy: "same-origin" },
      { headers: { stsSeconds: 31536000, stsIncludeSubdomains: true, frameDeny: true, contentTypeNosniff: true, referrerPolicy: "same-origin" } },
    ],
  ];

  it.each(cases)("ajoute un middleware %s et le relit à l'identique", (_label, spec, expected) => {
    const out = edit(GENERATED, { kind: "middleware", name: "mon-mw", spec });
    expect(js(out).http.middlewares["mon-mw"]).toEqual(expected);
    // Ce que l'assistant écrit, il le sait relire (donc le modifier).
    const read = readDynamic(out, ctx);
    expect(read).toMatchObject({ ok: true });
    if (read.ok) expect(read.middlewares[0]).toMatchObject({ name: "mon-mw", type: spec.type, spec });
  });

  it("conserve les commentaires et les autres sections (ici le TLS généré)", () => {
    const out = edit(GENERATED, { kind: "middleware", name: "a", spec: { type: "compress" } });
    expect(out).toContain("# Configuration dynamique");
    expect(js(out).tls).toEqual({ options: { default: { minVersion: "VersionTLS12" } } });
  });

  it("remplace un middleware existant sans toucher aux autres", () => {
    let out = edit(GENERATED, { kind: "middleware", name: "a", spec: { type: "rateLimit", average: 10, burst: 5 } });
    out = edit(out, { kind: "middleware", name: "b", spec: { type: "compress" } });
    out = edit(out, { kind: "middleware", name: "a", spec: { type: "rateLimit", average: 20, burst: 9 } });
    expect(js(out).http.middlewares).toEqual({ a: { rateLimit: { average: 20, burst: 9 } }, b: { compress: {} } });
    expect(edit(out, { kind: "middleware", name: "a", spec: { type: "rateLimit", average: 20, burst: 9 } })).toBe(out);
  });

  it("fonctionne sur un fichier vide ou fait seulement de commentaires", () => {
    expect(js(edit("", { kind: "middleware", name: "a", spec: { type: "compress" } })).http.middlewares.a).toEqual({ compress: {} });
    const out = edit("# rien ici\n", { kind: "middleware", name: "a", spec: { type: "compress" } });
    expect(js(out).http.middlewares.a).toEqual({ compress: {} });
    expect(out).toContain("# rien ici");
  });

  it("refuse de modifier un middleware dont les réglages ne sont pas tous gérés", () => {
    const text = "http:\n  middlewares:\n    a:\n      rateLimit:\n        average: 5\n        burst: 5\n        period: 1m\n";
    expect(refuse(text, { kind: "middleware", name: "a", spec: { type: "compress" } }).code).toBe("not_editable");
    const unknown = "http:\n  middlewares:\n    a:\n      redirectRegex:\n        regex: x\n        replacement: y\n";
    expect(refuse(unknown, { kind: "middleware", name: "a", spec: { type: "compress" } }).code).toBe("not_editable");
    // Le fichier n'est pas modifié par un refus : l'exception est levée avant toute écriture.
  });

  it("supprime un middleware, et la section http devient vide proprement", () => {
    const added = edit(GENERATED, { kind: "middleware", name: "a", spec: { type: "compress" } });
    const removed = edit(added, { kind: "middleware-delete", name: "a" });
    expect(js(removed).http).toBeUndefined();
    expect(js(removed).tls).toBeDefined();
  });

  it("refuse de supprimer un middleware inconnu ou utilisé par une route", () => {
    expect(refuse(GENERATED, { kind: "middleware-delete", name: "absent" }).code).toBe("not_found");
    let out = edit(GENERATED, { kind: "middleware", name: "auth", spec: { type: "basicAuth", users: [BCRYPT] } });
    out = edit(out, { kind: "route", name: "nas", spec: route({ middlewares: ["auth"] }) });
    const e = refuse(out, { kind: "middleware-delete", name: "auth" });
    expect(e.code).toBe("in_use");
    expect(e.details).toEqual(["nas"]);
    // La référence « nom@file » compte aussi.
    const withFile = out.replace("- auth", "- auth@file");
    expect(refuse(withFile, { kind: "middleware-delete", name: "auth" }).code).toBe("in_use");
  });

  it("refuse un nom ou des réglages invalides, et un fichier illisible", () => {
    expect(refuse(GENERATED, { kind: "middleware", name: "Mauvais Nom", spec: { type: "compress" } }).code).toBe("invalid");
    expect(refuse(GENERATED, { kind: "middleware", name: "a", spec: { type: "rateLimit", average: 0, burst: 1 } }).code).toBe("invalid");
    expect(refuse("http: [", { kind: "middleware", name: "a", spec: { type: "compress" } }).code).toBe("unsupported");
    expect(refuse("http: 3\n", { kind: "middleware", name: "a", spec: { type: "compress" } }).code).toBe("unsupported");
    expect(refuse("- a\n- b\n", { kind: "middleware", name: "a", spec: { type: "compress" } }).code).toBe("unsupported");
  });
});

describe("editDynamic : routes vers d'autres hôtes", () => {
  it("crée le routeur et le service avec l'entrypoint et le résolveur mémorisés", () => {
    const out = edit(GENERATED, { kind: "route", name: "nas", spec: route({ hosts: ["nas.exemple.fr", "stockage.exemple.fr"], urls: ["http://10.0.0.5:8080", "https://10.0.0.6"] }) });
    const d = js(out);
    expect(d.http.routers.nas).toEqual({
      rule: "Host(`nas.exemple.fr`) || Host(`stockage.exemple.fr`)",
      entryPoints: ["websecure"],
      service: "nas",
      tls: { certResolver: "letsencrypt" },
    });
    expect(d.http.services.nas).toEqual({ loadBalancer: { servers: [{ url: "http://10.0.0.5:8080" }, { url: "https://10.0.0.6" }] } });
    expect(d.tls).toBeDefined();
  });

  it("référence des middlewares définis dans le fichier ou d'un autre fournisseur", () => {
    const withMw = edit(GENERATED, { kind: "middleware", name: "limite", spec: { type: "rateLimit", average: 10, burst: 5 } });
    const out = edit(withMw, { kind: "route", name: "nas", spec: route({ middlewares: ["limite", "securite@docker"] }) });
    expect(js(out).http.routers.nas.middlewares).toEqual(["limite", "securite@docker"]);
    expect(refuse(GENERATED, { kind: "route", name: "nas", spec: route({ middlewares: ["absent"] }) }).message).toMatch(/n'existe pas dans ce fichier/);
  });

  it("relit une route qu'il a écrite et la remplace sans doublon", () => {
    let out = edit(GENERATED, { kind: "route", name: "nas", spec: route() });
    const read = readDynamic(out, ctx);
    expect(read.ok && read.routes[0]).toMatchObject({ name: "nas", hosts: ["nas.exemple.fr"], urls: ["http://10.0.0.5:8080"], spec: { hosts: ["nas.exemple.fr"] } });
    out = edit(out, { kind: "route", name: "nas", spec: route({ hosts: ["autre.exemple.fr"], urls: ["http://10.0.0.9:80"] }) });
    expect(Object.keys(js(out).http.routers)).toEqual(["nas"]);
    expect(js(out).http.services.nas.loadBalancer.servers).toEqual([{ url: "http://10.0.0.9:80" }]);
  });

  it("supprime la route et son service, et nettoie les sections vides", () => {
    const added = edit(GENERATED, { kind: "route", name: "nas", spec: route() });
    const removed = edit(added, { kind: "route-delete", name: "nas" });
    expect(js(removed).http).toBeUndefined();
    expect(refuse(removed, { kind: "route-delete", name: "nas" }).code).toBe("not_found");
  });

  it("ne touche pas aux routes et services écrits à la main", () => {
    const text = `http:
  routers:
    manuelle:
      rule: Host(\`x.exemple.fr\`) && PathPrefix(\`/api\`)
      service: manuel
  services:
    manuel:
      loadBalancer:
        servers:
          - url: http://10.0.0.1:80
        healthCheck:
          path: /ping
`;
    expect(refuse(text, { kind: "route", name: "manuelle", spec: route() }).code).toBe("not_editable");
    expect(refuse(text, { kind: "route-delete", name: "manuelle" }).code).toBe("not_editable");
    // Un service du même nom sans routeur : conflit plutôt que d'écraser.
    expect(refuse(text, { kind: "route", name: "manuel", spec: route() }).code).toBe("conflict");
    // Une autre route s'ajoute sans rien perdre.
    const out = edit(text, { kind: "route", name: "nas", spec: route() });
    expect(js(out).http.services.manuel.loadBalancer.healthCheck).toEqual({ path: "/ping" });
    expect(js(out).http.routers.manuelle.rule).toContain("PathPrefix");
  });

  it("les routes d'une autre forme sont listées en lecture seule", () => {
    const text = "http:\n  routers:\n    a:\n      rule: PathPrefix(`/x`)\n      service: s\n      entryPoints: [web]\n";
    const read = readDynamic(text, ctx);
    expect(read.ok && read.routes[0]).toMatchObject({ name: "a", spec: null });
    expect(read.ok && read.routes[0]?.summary).toMatch(/modifiez le fichier/);
  });

  it("refuse les saisies invalides", () => {
    const bad = (s: Partial<RouteSpec>) => refuse(GENERATED, { kind: "route", name: "nas", spec: route(s) }).code;
    expect(bad({ hosts: [] })).toBe("invalid");
    expect(bad({ hosts: ["pas un domaine"] })).toBe("invalid");
    expect(bad({ urls: [] })).toBe("invalid");
    expect(bad({ urls: ["10.0.0.5:8080"] })).toBe("invalid");
    expect(bad({ urls: ["ftp://10.0.0.5"] })).toBe("invalid");
    expect(bad({ urls: ["http://10.0.0.5:99999"] })).toBe("invalid");
    expect(bad({ urls: ["http://{{ env }}"] })).toBe("invalid");
    expect(bad({ hosts: ["a.fr", "a.fr"] })).toBe("invalid");
  });
});

describe("validation", () => {
  it("adresses et plages IP", () => {
    const ok = (r: string[]) => validateMiddlewareSpec({ type: "ipAllowList", sourceRange: r });
    expect(ok(["10.0.0.0/8", "192.168.1.5", "2001:db8::/32", "::1"])).toBeNull();
    for (const bad of ["10.0.0.256", "10.0.0.0/33", "10.0/8", "abc", "10.0.0.0/8/1", "1.2.3.4.5"]) expect(ok([bad])).not.toBeNull();
    expect(ok([])).not.toBeNull();
  });

  it("utilisateurs : mot de passe haché obligatoire, jamais en clair", () => {
    const users = (u: string[]) => validateMiddlewareSpec({ type: "basicAuth", users: u });
    expect(users([BCRYPT])).toBeNull();
    expect(users([`bob:$apr1$abcdefgh$${"b".repeat(22)}`])).toBeNull();
    expect(users([`bob:{SHA}${"c".repeat(27)}=`])).toBeNull();
    expect(users(["bob:motdepasse"])).toMatch(/déjà haché/);
    expect(users(["bob"])).toMatch(/déjà haché/);
    expect(users([`bob:{{ .x }}`])).toMatch(/\{\{/);
    expect(users([])).not.toBeNull();
  });

  it("préfixes, politique de référent", () => {
    expect(validateMiddlewareSpec({ type: "stripPrefix", prefixes: ["/api", "/v1/x"] })).toBeNull();
    expect(validateMiddlewareSpec({ type: "stripPrefix", prefixes: ["api"] })).not.toBeNull();
    expect(validateMiddlewareSpec({ type: "headers", hsts: false, frameDeny: false, contentTypeNosniff: false, referrerPolicy: "inconnue" })).not.toBeNull();
    expect(validateRouteSpec(route())).toBeNull();
  });
});

describe("readDynamic", () => {
  it("lit le fichier généré par l'assistant : rien à lister", () => {
    expect(readDynamic(GENERATED, ctx)).toEqual({ ok: true, middlewares: [], routes: [] });
  });

  it("liste des middlewares inconnus en lecture seule, sans planter", () => {
    const read = readDynamic("http:\n  middlewares:\n    r:\n      redirectRegex:\n        regex: a\n        replacement: b\n    n: 3\n", ctx);
    expect(read.ok && read.middlewares).toEqual([
      expect.objectContaining({ name: "r", type: "redirectRegex", spec: null }),
      expect.objectContaining({ name: "n", type: null, spec: null }),
    ]);
  });

  it("signale un YAML invalide ou une racine incorrecte", () => {
    expect(readDynamic("http: [", ctx)).toMatchObject({ ok: false });
    expect(readDynamic("- a\n", ctx)).toMatchObject({ ok: false, error: expect.stringMatching(/mapping/) });
    expect(readDynamic("", ctx)).toEqual({ ok: true, middlewares: [], routes: [] });
  });

  it("une route sur un autre entrypoint ou résolveur n'est pas modifiable", () => {
    const text = "http:\n  routers:\n    a:\n      rule: Host(`a.fr`)\n      entryPoints: [web]\n      service: a\n      tls:\n        certResolver: letsencrypt\n  services:\n    a:\n      loadBalancer:\n        servers:\n          - url: http://10.0.0.1\n";
    expect(readDynamic(text, ctx).ok && (readDynamic(text, ctx) as any).routes[0].spec).toBeNull();
    expect((readDynamic(text.replace("[web]", "[websecure]"), ctx) as any).routes[0].spec).not.toBeNull();
  });
});

describe("hasBasicAuth", () => {
  it("détecte un middleware d'authentification", () => {
    expect(hasBasicAuth(GENERATED)).toBe(false);
    expect(hasBasicAuth(edit(GENERATED, { kind: "middleware", name: "auth", spec: { type: "basicAuth", users: [BCRYPT] } }))).toBe(true);
    expect(hasBasicAuth("http: [")).toBe(false);
  });
});
