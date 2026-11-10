import { isMap, isScalar, parse, parseDocument } from "yaml";
import type { Document, YAMLMap } from "yaml";
import { detectStyle } from "./compose-edit.js";

/**
 * Configuration dynamique de Traefik (fichier `dynamic/dynamic.yml`) : middlewares et routes vers des services
 * hors Docker local (autres hôtes). Seuls les éléments dont la forme est entièrement connue sont modifiables ; le
 * reste du fichier (commentaires, autres sections, éléments écrits à la main) est conservé tel quel.
 */

// --- Modèle ------------------------------------------------------------------------------------------

export type MiddlewareSpec =
  | { type: "ipAllowList"; sourceRange: string[] }
  | { type: "rateLimit"; average: number; burst: number }
  | { type: "headers"; hsts: boolean; frameDeny: boolean; contentTypeNosniff: boolean; referrerPolicy: string }
  | { type: "compress" }
  | { type: "basicAuth"; users: string[] }
  | { type: "stripPrefix"; prefixes: string[] };

export interface RouteSpec {
  hosts: string[];
  /** Adresses des serveurs (`http://10.0.0.5:8080`) vers lesquels Traefik répartit les requêtes. */
  urls: string[];
  /** Middlewares : nom défini dans ce fichier, ou `nom@fournisseur`. */
  middlewares: string[];
}

export type DynamicChange =
  | { kind: "middleware"; name: string; spec: MiddlewareSpec }
  | { kind: "middleware-delete"; name: string }
  | { kind: "route"; name: string; spec: RouteSpec }
  | { kind: "route-delete"; name: string };

export interface DynamicContext {
  /** Entrypoint HTTPS des routes. */
  entryPoint: string;
  certResolver: string;
}

export type DynamicErrorCode = "invalid" | "not_found" | "not_editable" | "in_use" | "conflict" | "unsupported";

export class DynamicEditError extends Error {
  constructor(
    public readonly code: DynamicErrorCode,
    message: string,
    /** Éléments qui retiennent la modification (suppression d'un middleware utilisé). */
    public readonly details: string[] = [],
  ) {
    super(message);
  }
}

export const MIDDLEWARE_TYPES = ["ipAllowList", "rateLimit", "headers", "compress", "basicAuth", "stripPrefix"] as const;
export const REFERRER_POLICIES = ["", "no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url"] as const;
const HSTS_SECONDS = 31536000;

// --- Validation --------------------------------------------------------------------------------------

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}(@[a-z]+)?$/;
const URL_RE = /^https?:\/\/(?:[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/;
const USER_LINE = /^[A-Za-z0-9._@-]{1,64}:(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}|\$apr1\$[./A-Za-z0-9]{1,8}\$[./A-Za-z0-9]{22}|\{SHA\}[A-Za-z0-9+/=]{28})$/;

export const validateDynamicName = (name: string): string | null =>
  NAME.test(name) ? null : "Nom invalide : minuscules, chiffres, « - » et « _ » (63 caractères au plus, commence par une lettre ou un chiffre).";

function validCidr(value: string): boolean {
  const [addr, prefix, extra] = value.split("/");
  if (extra !== undefined || !addr) return false;
  if (addr.includes(":")) return /^[0-9A-Fa-f:.]+$/.test(addr) && (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128));
  const octets = addr.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  return prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
}

/** Les valeurs ne doivent pas contenir de modèle Go (`{{ … }}`) : Traefik les interpréterait dans le fichier. */
const noTemplate = (s: string): boolean => !s.includes("{{") && !s.includes("}}");

export function validateMiddlewareSpec(spec: MiddlewareSpec): string | null {
  switch (spec.type) {
    case "ipAllowList":
      if (spec.sourceRange.length === 0 || spec.sourceRange.length > 50) return "Indiquez de 1 à 50 adresses ou plages.";
      for (const r of spec.sourceRange) if (!validCidr(r)) return `Adresse ou plage invalide : « ${r} » (ex. 10.0.0.0/8, 192.168.1.5, 2001:db8::/32).`;
      return null;
    case "rateLimit":
      if (!Number.isInteger(spec.average) || spec.average < 1 || spec.average > 1_000_000) return "Débit moyen invalide (1 à 1 000 000 requêtes par seconde).";
      if (!Number.isInteger(spec.burst) || spec.burst < 1 || spec.burst > 1_000_000) return "Rafale invalide (1 à 1 000 000).";
      return null;
    case "headers":
      return (REFERRER_POLICIES as readonly string[]).includes(spec.referrerPolicy) ? null : "Politique de référent inconnue.";
    case "compress":
      return null;
    case "basicAuth":
      if (spec.users.length === 0 || spec.users.length > 20) return "Indiquez de 1 à 20 utilisateurs.";
      for (const u of spec.users) {
        if (!noTemplate(u)) return "Une valeur ne peut pas contenir « {{ » ni « }} ».";
        if (!USER_LINE.test(u)) {
          return "Chaque utilisateur est une ligne « nom:empreinte » avec un mot de passe déjà haché (bcrypt, apr1 ou SHA1), par exemple générée par « htpasswd -nbB nom motdepasse ». Un mot de passe en clair est refusé.";
        }
      }
      return null;
    case "stripPrefix":
      if (spec.prefixes.length === 0 || spec.prefixes.length > 5) return "Indiquez de 1 à 5 préfixes.";
      for (const p of spec.prefixes) if (!/^\/[A-Za-z0-9/_.-]{0,127}$/.test(p)) return `Préfixe invalide : « ${p} » (commence par « / »).`;
      return null;
    default:
      return "Type de middleware non pris en charge.";
  }
}

export function validateRouteSpec(spec: RouteSpec): string | null {
  if (spec.hosts.length === 0 || spec.hosts.length > 5) return "Indiquez de 1 à 5 noms de domaine.";
  for (const h of spec.hosts) if (!HOST.test(h)) return `Nom de domaine invalide : « ${h} » (minuscules, chiffres, « - » et « . »).`;
  if (new Set(spec.hosts).size !== spec.hosts.length) return "Un nom de domaine est répété.";
  if (spec.urls.length === 0 || spec.urls.length > 5) return "Indiquez de 1 à 5 adresses de serveur.";
  for (const u of spec.urls) {
    if (!URL_RE.test(u) || !noTemplate(u)) return `Adresse invalide : « ${u} » (ex. http://10.0.0.5:8080).`;
    const port = /:(\d{1,5})(?:\/|$)/.exec(u.replace(/^https?:\/\/(\[[^\]]*\]|[^/:]*)/, ""));
    if (port && Number(port[1]) > 65535) return `Port invalide dans « ${u} ».`;
  }
  if (new Set(spec.urls).size !== spec.urls.length) return "Une adresse de serveur est répétée.";
  if (spec.middlewares.length > 10) return "Dix middlewares au plus.";
  for (const m of spec.middlewares) if (!REFERENCE.test(m)) return `Nom de middleware invalide : « ${m} ».`;
  return null;
}

// --- Forme YAML des middlewares ----------------------------------------------------------------------

/** Contenu YAML d'un middleware (sans le nom). */
export function middlewareToYaml(spec: MiddlewareSpec): Record<string, unknown> {
  switch (spec.type) {
    case "ipAllowList":
      return { ipAllowList: { sourceRange: spec.sourceRange } };
    case "rateLimit":
      return { rateLimit: { average: spec.average, burst: spec.burst } };
    case "headers": {
      const h: Record<string, unknown> = {};
      if (spec.hsts) {
        h.stsSeconds = HSTS_SECONDS;
        h.stsIncludeSubdomains = true;
      }
      if (spec.frameDeny) h.frameDeny = true;
      if (spec.contentTypeNosniff) h.contentTypeNosniff = true;
      if (spec.referrerPolicy) h.referrerPolicy = spec.referrerPolicy;
      return { headers: h };
    }
    case "compress":
      return { compress: {} };
    case "basicAuth":
      return { basicAuth: { users: spec.users } };
    case "stripPrefix":
      return { stripPrefix: { prefixes: spec.prefixes } };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** Spec modifiable d'un middleware lu dans le fichier ; null si sa forme n'est pas entièrement connue. */
export function middlewareFromYaml(value: unknown): MiddlewareSpec | null {
  if (!isObj(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const type = keys[0] as string;
  const body = value[type];
  switch (type) {
    case "ipAllowList": {
      if (!isObj(body) || !onlyKeys(body, ["sourceRange"])) return null;
      const range = strings(body.sourceRange);
      return range ? { type, sourceRange: range } : null;
    }
    case "rateLimit":
      if (!isObj(body) || !onlyKeys(body, ["average", "burst"]) || typeof body.average !== "number" || typeof body.burst !== "number") return null;
      return { type, average: body.average, burst: body.burst };
    case "headers": {
      if (!isObj(body) || !onlyKeys(body, ["stsSeconds", "stsIncludeSubdomains", "frameDeny", "contentTypeNosniff", "referrerPolicy"])) return null;
      const hsts = body.stsSeconds !== undefined;
      // L'écriture de l'assistant : un an, sous-domaines compris. Une autre valeur ne peut pas être reproduite.
      if (hsts && (body.stsSeconds !== HSTS_SECONDS || body.stsIncludeSubdomains !== true)) return null;
      if (!hsts && body.stsIncludeSubdomains !== undefined) return null;
      const referrer = body.referrerPolicy === undefined ? "" : body.referrerPolicy;
      if (typeof referrer !== "string" || !(REFERRER_POLICIES as readonly string[]).includes(referrer)) return null;
      return { type, hsts, frameDeny: body.frameDeny === true, contentTypeNosniff: body.contentTypeNosniff === true, referrerPolicy: referrer };
    }
    case "compress":
      return body === null || (isObj(body) && Object.keys(body).length === 0) ? { type } : null;
    case "basicAuth": {
      if (!isObj(body) || !onlyKeys(body, ["users"])) return null;
      const users = strings(body.users);
      return users ? { type, users } : null;
    }
    case "stripPrefix": {
      if (!isObj(body) || !onlyKeys(body, ["prefixes"])) return null;
      const prefixes = strings(body.prefixes);
      return prefixes ? { type, prefixes } : null;
    }
    default:
      return null;
  }
}

export function summarizeMiddleware(value: unknown, spec: MiddlewareSpec | null): string {
  if (spec) {
    switch (spec.type) {
      case "ipAllowList":
        return `Autorise ${spec.sourceRange.length} adresse(s) ou plage(s) : ${spec.sourceRange.slice(0, 3).join(", ")}${spec.sourceRange.length > 3 ? "…" : ""}`;
      case "rateLimit":
        return `${spec.average} requête(s) par seconde, rafale de ${spec.burst}`;
      case "headers":
        return ["HSTS", spec.frameDeny ? "anti-iframe" : "", spec.contentTypeNosniff ? "nosniff" : "", spec.referrerPolicy ? `référent ${spec.referrerPolicy}` : ""].filter(Boolean).join(", ") || "En-têtes";
      case "compress":
        return "Compression des réponses";
      case "basicAuth":
        return `${spec.users.length} utilisateur(s), mot de passe demandé`;
      case "stripPrefix":
        return `Retire ${spec.prefixes.join(", ")}`;
    }
  }
  const type = isObj(value) ? Object.keys(value)[0] : undefined;
  return type ? `Type « ${type} » ou réglages que l'assistant ne gère pas : modifiez le fichier.` : "Forme non reconnue : modifiez le fichier.";
}

// --- Lecture -----------------------------------------------------------------------------------------

export interface MiddlewareView {
  name: string;
  /** Type Traefik (`ipAllowList`, `basicAuth`…), ou null si illisible. */
  type: string | null;
  summary: string;
  /** Réglages modifiables par l'assistant ; null : lecture seule (modifier le fichier). */
  spec: MiddlewareSpec | null;
}

export interface RouteView {
  name: string;
  hosts: string[];
  urls: string[];
  middlewares: string[];
  summary: string;
  spec: RouteSpec | null;
}

export type DynamicReading = { ok: true; middlewares: MiddlewareView[]; routes: RouteView[] } | { ok: false; error: string };

const HOST_RULE = /^\s*Host\(`([^`]+)`\)(\s*\|\|\s*Host\(`([^`]+)`\))*\s*$/;

/** Route modifiable : exactement la forme que l'assistant écrit. */
function routeFromYaml(name: string, router: unknown, services: Record<string, unknown>, ctx: DynamicContext): RouteSpec | null {
  if (!isObj(router) || !onlyKeys(router, ["rule", "entryPoints", "middlewares", "service", "tls"])) return null;
  if (typeof router.rule !== "string" || !HOST_RULE.test(router.rule)) return null;
  const eps = strings(router.entryPoints);
  if (!eps || eps.length !== 1 || eps[0] !== ctx.entryPoint) return null;
  if (router.service !== name) return null;
  const tls = router.tls;
  if (!isObj(tls) || !onlyKeys(tls, ["certResolver"]) || tls.certResolver !== ctx.certResolver) return null;
  const middlewares = router.middlewares === undefined ? [] : strings(router.middlewares);
  if (!middlewares) return null;
  const service = services[name];
  if (!isObj(service) || !onlyKeys(service, ["loadBalancer"]) || !isObj(service.loadBalancer) || !onlyKeys(service.loadBalancer, ["servers"])) return null;
  const servers = service.loadBalancer.servers;
  if (!Array.isArray(servers) || servers.length === 0) return null;
  const urls: string[] = [];
  for (const s of servers) {
    if (!isObj(s) || !onlyKeys(s, ["url"]) || typeof s.url !== "string") return null;
    urls.push(s.url);
  }
  const hosts = [...router.rule.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1] as string);
  return { hosts, urls, middlewares };
}

/** Middlewares et routes du fichier (YAML invalide : erreur, jamais d'exception). */
export function readDynamic(text: string, ctx: DynamicContext): DynamicReading {
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 100 });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] ?? "YAML invalide" : "YAML invalide" };
  }
  if (doc !== null && doc !== undefined && !isObj(doc)) return { ok: false, error: "Le fichier doit être un mapping YAML." };
  const http = isObj(doc) && isObj(doc.http) ? doc.http : {};
  const mws = isObj(http.middlewares) ? http.middlewares : {};
  const routers = isObj(http.routers) ? http.routers : {};
  const services = isObj(http.services) ? http.services : {};

  const middlewares: MiddlewareView[] = Object.entries(mws).map(([name, value]) => {
    const spec = middlewareFromYaml(value);
    return { name, type: isObj(value) ? (Object.keys(value)[0] ?? null) : null, summary: summarizeMiddleware(value, spec), spec };
  });
  const routes: RouteView[] = Object.entries(routers).map(([name, router]) => {
    const spec = routeFromYaml(name, router, services, ctx);
    if (spec) return { name, hosts: spec.hosts, urls: spec.urls, middlewares: spec.middlewares, summary: `${spec.hosts.join(", ")} → ${spec.urls.join(", ")}`, spec };
    const r = isObj(router) ? router : {};
    const rule = typeof r.rule === "string" ? r.rule : "";
    return {
      name,
      hosts: [...rule.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1] as string),
      urls: [],
      middlewares: strings(r.middlewares) ?? [],
      summary: rule ? `Règle « ${rule} » : modifiez le fichier.` : "Forme non reconnue : modifiez le fichier.",
      spec: null,
    };
  });
  return { ok: true, middlewares, routes };
}

// --- Écriture ----------------------------------------------------------------------------------------

function openDoc(text: string): Document {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new DynamicEditError("unsupported", "Le fichier actuel n'est pas un YAML valide : corrigez-le d'abord dans l'onglet Fichiers.");
  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) doc.contents = doc.createNode({}) as never;
  if (!isMap(doc.contents)) throw new DynamicEditError("unsupported", "Le fichier doit être un mapping YAML.");
  return doc;
}

function section(doc: Document, parent: YAMLMap, key: string, create: boolean): YAMLMap | null {
  const node = parent.get(key, true);
  if (isMap(node)) return node;
  if (node !== undefined && node !== null && !(isScalar(node) && node.value === null)) {
    throw new DynamicEditError("unsupported", `La section « ${key} » n'est pas un mapping : modification refusée.`);
  }
  if (!create) return null;
  const created = doc.createNode({}) as YAMLMap;
  parent.set(key, created);
  return created;
}

const toJs = (node: unknown): unknown => (node && typeof (node as { toJSON?: () => unknown }).toJSON === "function" ? (node as { toJSON: () => unknown }).toJSON() : node);

function referencedBy(routers: YAMLMap | null, name: string): string[] {
  if (!routers) return [];
  const out: string[] = [];
  for (const pair of routers.items) {
    const router = toJs(pair.value);
    const list = isObj(router) ? strings(router.middlewares) : null;
    if (list?.some((m) => m === name || m === `${name}@file`)) out.push(String(isScalar(pair.key) ? pair.key.value : pair.key));
  }
  return out;
}

/** Applique une modification et rend le nouveau contenu du fichier. */
export function editDynamic(text: string, change: DynamicChange, ctx: DynamicContext): string {
  const nameError = validateDynamicName(change.name);
  if (nameError) throw new DynamicEditError("invalid", nameError);
  const doc = openDoc(text);
  const root = doc.contents as YAMLMap;
  const create = change.kind === "middleware" || change.kind === "route";
  const http = section(doc, root, "http", create);
  const middlewares = http ? section(doc, http, "middlewares", change.kind === "middleware") : null;
  const routers = http ? section(doc, http, "routers", change.kind === "route") : null;
  const services = http ? section(doc, http, "services", change.kind === "route") : null;

  switch (change.kind) {
    case "middleware": {
      const err = validateMiddlewareSpec(change.spec);
      if (err) throw new DynamicEditError("invalid", err);
      const current = (middlewares as YAMLMap).get(change.name, true);
      if (current !== undefined && middlewareFromYaml(toJs(current)) === null) {
        throw new DynamicEditError("not_editable", `Le middleware « ${change.name} » a un type ou des réglages que l'assistant ne gère pas : modifiez le fichier.`);
      }
      (middlewares as YAMLMap).set(change.name, doc.createNode(middlewareToYaml(change.spec)));
      break;
    }
    case "middleware-delete": {
      if (!middlewares || !middlewares.has(change.name)) throw new DynamicEditError("not_found", `Middleware « ${change.name} » introuvable.`);
      const users = referencedBy(routers, change.name);
      if (users.length > 0) throw new DynamicEditError("in_use", `Le middleware « ${change.name} » est utilisé par des routes de ce fichier.`, users);
      middlewares.delete(change.name);
      if (middlewares.items.length === 0 && http) http.delete("middlewares");
      break;
    }
    case "route": {
      const err = validateRouteSpec(change.spec);
      if (err) throw new DynamicEditError("invalid", err);
      const defined = new Set((middlewares?.items ?? []).map((p) => String(isScalar(p.key) ? p.key.value : p.key)));
      for (const m of change.spec.middlewares) {
        if (!m.includes("@") && !defined.has(m)) throw new DynamicEditError("invalid", `Le middleware « ${m} » n'existe pas dans ce fichier (pour un autre fournisseur, écrivez « ${m}@docker » par exemple).`);
      }
      const r = routers as YAMLMap;
      const s = services as YAMLMap;
      const existing = r.get(change.name, true);
      if (existing !== undefined) {
        const plain = toJs(services ? s.toJSON() : {});
        if (routeFromYaml(change.name, toJs(existing), isObj(plain) ? plain : {}, ctx) === null) {
          throw new DynamicEditError("not_editable", `La route « ${change.name} » a des réglages que l'assistant ne gère pas : modifiez le fichier.`);
        }
      } else if (s.has(change.name)) {
        throw new DynamicEditError("conflict", `Un service « ${change.name} » existe déjà dans ce fichier : choisissez un autre nom.`);
      }
      const router: Record<string, unknown> = { rule: change.spec.hosts.map((h) => `Host(\`${h}\`)`).join(" || "), entryPoints: [ctx.entryPoint] };
      if (change.spec.middlewares.length > 0) router.middlewares = change.spec.middlewares;
      router.service = change.name;
      router.tls = { certResolver: ctx.certResolver };
      r.set(change.name, doc.createNode(router));
      s.set(change.name, doc.createNode({ loadBalancer: { servers: change.spec.urls.map((url) => ({ url })) } }));
      break;
    }
    case "route-delete": {
      if (!routers || !routers.has(change.name)) throw new DynamicEditError("not_found", `Route « ${change.name} » introuvable.`);
      const plain = services ? toJs(services.toJSON()) : {};
      if (routeFromYaml(change.name, toJs(routers.get(change.name, true)), isObj(plain) ? plain : {}, ctx) === null) {
        throw new DynamicEditError("not_editable", `La route « ${change.name} » a des réglages que l'assistant ne gère pas : supprimez-la dans le fichier.`);
      }
      routers.delete(change.name);
      services?.delete(change.name);
      if (routers.items.length === 0 && http) http.delete("routers");
      if (services && services.items.length === 0 && http) http.delete("services");
      break;
    }
  }
  if (http && http.items.length === 0) root.delete("http");

  const style = detectStyle(text);
  return doc.toString({
    indent: style.indent,
    indentSeq: style.indentSeq,
    ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
    lineWidth: 0,
  });
}

/** Le contenu contient-il un middleware d'authentification (mots de passe hachés) ? */
export function hasBasicAuth(text: string): boolean {
  const r = readDynamic(text, { entryPoint: "", certResolver: "" });
  return r.ok && r.middlewares.some((m) => m.type === "basicAuth");
}
