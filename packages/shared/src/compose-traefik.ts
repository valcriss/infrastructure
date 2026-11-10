import { isAlias, isMap, isScalar, isSeq, parse, parseDocument } from "yaml";
import type { Document, YAMLMap, YAMLSeq } from "yaml";
import { ComposeEditError, detectStyle } from "./compose-edit.js";

/**
 * Exposition d'un service Compose par Traefik (fournisseur Docker) : écriture et lecture des labels que la console
 * gère, rattachement du service au réseau de Traefik. Seuls les labels du routeur de la console sont touchés ; ceux
 * écrits à la main (autres routeurs, autres services) sont conservés.
 */

export interface TraefikExposure {
  /** Noms de domaine servis (règle `Host(...)`). */
  hosts: string[];
  /** Port d'écoute du service dans le conteneur. */
  port: number;
  /** Middlewares appliqués au routeur (`auth@file`, `securite`…). */
  middlewares: string[];
}

export interface TraefikContext {
  /** Nom du routeur et du service Traefik : unique parmi tous les conteneurs de l'hôte. */
  routerName: string;
  /** Entrypoint HTTPS. */
  entryPoint: string;
  certResolver: string;
  /** Nom (réel) du réseau Docker partagé avec Traefik. */
  network: string;
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MIDDLEWARE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}(@[a-z]+)?$/;

export function validateTraefikExposure(e: TraefikExposure): string | null {
  if (e.hosts.length === 0 || e.hosts.length > 5) return "Indiquez de 1 à 5 noms de domaine.";
  for (const h of e.hosts) if (!HOST.test(h)) return `Nom de domaine invalide : « ${h} » (minuscules, chiffres, « - » et « . »).`;
  if (new Set(e.hosts).size !== e.hosts.length) return "Un nom de domaine est répété.";
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) return "Port invalide (1 à 65535).";
  if (e.middlewares.length > 10) return "Dix middlewares au plus.";
  for (const m of e.middlewares) if (!MIDDLEWARE.test(m)) return `Nom de middleware invalide : « ${m} ».`;
  return null;
}

/** Nom de routeur : applications et services peuvent avoir le même nom d'un projet à l'autre, pas le routeur. */
export function traefikRouterName(stack: string, service: string): string {
  return `${stack}-${service}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
}

// --- Lecture -----------------------------------------------------------------------------------------

export interface TraefikReading {
  exposure: TraefikExposure;
  entryPoint: string | null;
  certResolver: string | null;
  network: string | null;
  /** La règle du routeur contient autre chose que des `Host(...)` : elle sera remplacée si on l'enregistre. */
  customRule: boolean;
}

function labelsOf(service: unknown): Record<string, string> {
  const raw = (service as { labels?: unknown } | null)?.labels;
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      out[eq === -1 ? item : item.slice(0, eq)] = eq === -1 ? "" : item.slice(eq + 1);
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = v === null || v === undefined ? "" : String(v);
  }
  return out;
}

/** Exposition configurée pour ce routeur dans le Compose, ou null (aucun routeur de ce nom, ou YAML illisible). */
export function readServiceTraefik(text: string, service: string, routerName: string): TraefikReading | null {
  let doc: { services?: Record<string, unknown> } | null;
  try {
    doc = parse(text, { maxAliasCount: 100 }) as { services?: Record<string, unknown> } | null;
  } catch {
    return null;
  }
  const svc = doc?.services?.[service];
  if (!svc) return null;
  const l = labelsOf(svc);
  const rule = l[`traefik.http.routers.${routerName}.rule`];
  if (rule === undefined) return null;
  const hosts = [...rule.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1] as string);
  const customRule = rule.replace(/Host\(`[^`]+`\)/g, "").replace(/[\s|]/g, "") !== "";
  const port = Number(l[`traefik.http.services.${routerName}.loadbalancer.server.port`]);
  const middlewares = (l[`traefik.http.routers.${routerName}.middlewares`] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return {
    exposure: { hosts, port: Number.isInteger(port) ? port : 0, middlewares },
    entryPoint: l[`traefik.http.routers.${routerName}.entrypoints`] ?? null,
    certResolver: l[`traefik.http.routers.${routerName}.tls.certresolver`] ?? null,
    network: l["traefik.docker.network"] ?? null,
    customRule,
  };
}

// --- Écriture ----------------------------------------------------------------------------------------

function labelEntries(ctx: TraefikContext, e: TraefikExposure): [string, string][] {
  const r = `traefik.http.routers.${ctx.routerName}`;
  const out: [string, string][] = [
    ["traefik.enable", "true"],
    ["traefik.docker.network", ctx.network],
    [`${r}.rule`, e.hosts.map((h) => `Host(\`${h}\`)`).join(" || ")],
    [`${r}.entrypoints`, ctx.entryPoint],
    [`${r}.tls`, "true"],
    [`${r}.tls.certresolver`, ctx.certResolver],
  ];
  if (e.middlewares.length > 0) out.push([`${r}.middlewares`, e.middlewares.join(",")]);
  out.push([`traefik.http.services.${ctx.routerName}.loadbalancer.server.port`, String(e.port)]);
  return out;
}

/** Clé d'un élément de `labels` (mapping ou liste « clé=valeur »). */
function keyOfSeqItem(item: unknown): string | null {
  if (!isScalar(item) || typeof item.value !== "string") return null;
  const eq = item.value.indexOf("=");
  return eq === -1 ? item.value : item.value.slice(0, eq);
}

function ensureTopLevelNetwork(doc: Document, network: string): string {
  const top = doc.get("networks", true);
  if (isAlias(top)) throw new ComposeEditError("unsupported_structure", "« networks » utilise un alias YAML : modification refusée.");
  const declare = () => doc.createNode({ name: network, external: true });
  if (top === undefined || top === null || (isScalar(top) && top.value === null)) {
    doc.set("networks", doc.createNode({ [network]: { name: network, external: true } }));
    return network;
  }
  if (!isMap(top)) throw new ComposeEditError("unsupported_structure", "« networks » doit être un mapping.");
  for (const pair of top.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : null;
    if (key === null) continue;
    const value = pair.value;
    const name = isMap(value) ? value.get("name") : undefined;
    const external = isMap(value) ? value.get("external") : undefined;
    const isExternal = external === true || isMap(external);
    if (name === network || (key === network && name === undefined)) {
      if (!isExternal) {
        throw new ComposeEditError("unsupported_structure", `Le réseau « ${network} » est déclaré dans ce Compose sans « external: true » : il serait créé séparément. Corrigez-le à la main.`);
      }
      return key;
    }
  }
  if (top.has(network)) throw new ComposeEditError("unsupported_structure", `Une entrée « ${network} » existe déjà dans « networks » avec une autre définition : modification refusée.`);
  top.set(network, declare());
  return network;
}

function attachNetwork(doc: Document, svc: YAMLMap, key: string): void {
  const nets = svc.get("networks", true);
  if (isAlias(nets)) throw new ComposeEditError("unsupported_structure", "« networks » du service utilise un alias YAML : modification refusée.");
  if (nets === undefined || nets === null || (isScalar(nets) && nets.value === null)) {
    // Déclarer « networks » retire le réseau implicite du projet : on le garde explicitement.
    svc.set("networks", doc.createNode(["default", key]));
  } else if (isSeq(nets)) {
    const has = (nets as YAMLSeq).items.some((it) => isScalar(it) && it.value === key);
    if (!has) nets.items.push(doc.createNode(key));
  } else if (isMap(nets)) {
    if (!nets.has(key)) nets.set(key, doc.createNode({}));
  } else {
    throw new ComposeEditError("unsupported_structure", "« networks » du service doit être une liste ou un mapping.");
  }
}

/**
 * Expose le service par Traefik (`exposure`) ou retire l'exposition de ce routeur (`null`). Le Compose est modifié en
 * conservant sa forme (commentaires, ordre, indentation) ; les structures ambiguës (alias, clé de fusion `<<`,
 * `network_mode`) sont refusées.
 */
export function editServiceTraefik(text: string, service: string, ctx: TraefikContext, exposure: TraefikExposure | null): string {
  if (exposure) {
    const err = validateTraefikExposure(exposure);
    if (err) throw new ComposeEditError("unsupported_structure", err);
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  const services = doc.get("services", true);
  if (!isMap(services)) throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  const svc = services.get(service, true);
  if (!isMap(svc)) throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  if (svc.has("<<")) throw new ComposeEditError("unsupported_structure", "Le service utilise une clé de fusion « << » : modification refusée.");
  if (exposure && svc.has("network_mode")) {
    throw new ComposeEditError("unsupported_structure", "Le service utilise « network_mode » : il ne peut pas rejoindre le réseau de Traefik.");
  }

  const labels = svc.get("labels", true);
  if (isAlias(labels)) throw new ComposeEditError("unsupported_structure", "« labels » utilise un alias YAML : modification refusée.");
  const absent = labels === undefined || labels === null || (isScalar(labels) && labels.value === null);
  if (!absent && !isMap(labels) && !isSeq(labels)) throw new ComposeEditError("unsupported_structure", "« labels » doit être un mapping ou une liste.");
  if (absent && !exposure) return text;

  const ours = (key: string): boolean => key.startsWith(`traefik.http.routers.${ctx.routerName}.`) || key.startsWith(`traefik.http.services.${ctx.routerName}.`);
  const entries = exposure ? labelEntries(ctx, exposure) : [];

  if (absent) {
    svc.set("labels", doc.createNode(Object.fromEntries(entries)));
  } else if (isMap(labels)) {
    labels.items = labels.items.filter((p) => !(isScalar(p.key) && typeof p.key.value === "string" && ours(p.key.value)));
    for (const [k, v] of entries) labels.set(k, v);
    dropOrphans(labels, exposure !== null);
    if (labels.items.length === 0) svc.delete("labels");
  } else if (isSeq(labels)) {
    const seq = labels;
    seq.items = seq.items.filter((it) => {
      const k = keyOfSeqItem(it);
      return k === null || !ours(k);
    });
    for (const [k, v] of entries) {
      const found = seq.items.find((it) => keyOfSeqItem(it) === k);
      if (found && isScalar(found)) found.value = `${k}=${v}`;
      else seq.items.push(doc.createNode(`${k}=${v}`));
    }
    if (!exposure) {
      const stillRouted = seq.items.some((it) => (keyOfSeqItem(it) ?? "").startsWith("traefik.http."));
      if (!stillRouted) seq.items = seq.items.filter((it) => !["traefik.enable", "traefik.docker.network"].includes(keyOfSeqItem(it) ?? ""));
    }
    if (seq.items.length === 0) svc.delete("labels");
  }

  if (exposure) attachNetwork(doc, svc, ensureTopLevelNetwork(doc, ctx.network));

  const style = detectStyle(text);
  return doc.toString({
    indent: style.indent,
    indentSeq: style.indentSeq,
    ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
    lineWidth: 0,
  });
}

/** Après un retrait : sans autre routeur, `traefik.enable` et `traefik.docker.network` n'ont plus de raison d'être. */
function dropOrphans(labels: YAMLMap, applying: boolean): void {
  if (applying) return;
  const stillRouted = labels.items.some((p) => isScalar(p.key) && typeof p.key.value === "string" && p.key.value.startsWith("traefik.http."));
  if (stillRouted) return;
  labels.items = labels.items.filter((p) => !(isScalar(p.key) && (p.key.value === "traefik.enable" || p.key.value === "traefik.docker.network")));
}

// --- Exposition de la console elle-même --------------------------------------------------------------

/**
 * Extrait à ajouter au service « console » du Compose de livraison pour le placer derrière Traefik. La console n'est
 * pas une application gérée par elle-même : l'extrait se copie à la main.
 */
export function traefikConsoleSnippet(ctx: Omit<TraefikContext, "routerName">, host: string, port = 8080): string {
  const e: TraefikExposure = { hosts: [host], port, middlewares: [] };
  const err = validateTraefikExposure(e);
  if (err) throw new Error(err);
  const labels = labelEntries({ ...ctx, routerName: "console" }, e)
    .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `# À ajouter au service « console » de docker-compose.yml (puis redéployer la console), en gardant ses autres réglages.
services:
  console:
    environment:
      # La console est servie en HTTPS : cookies de session « Secure ».
      SECURE_COOKIES: "true"
    labels:
${labels}
    networks:
      - internal
      - ${ctx.network}

networks:
  ${ctx.network}:
    name: ${ctx.network}
    external: true
`;
}
