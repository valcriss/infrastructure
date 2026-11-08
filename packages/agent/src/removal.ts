import type { AgentMessage, RemovalPlanMessage, RunMessage } from "@infra/shared";
import { rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { dockerGet, dockerRequest } from "./docker.js";

const PROJECT_LABEL = "com.docker.compose.project";
const MAX_LIST = 200;

type Plan = Extract<AgentMessage, { type: "removal_plan_result" }>;

interface RawContainer {
  Id?: unknown;
  Names?: unknown;
  Image?: unknown;
  ImageID?: unknown;
  State?: unknown;
  Mounts?: unknown;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const labelFilter = (project: string): string => encodeURIComponent(JSON.stringify({ label: [`${PROJECT_LABEL}=${project}`] }));
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function containersOf(socket: string, project: string): Promise<RawContainer[]> {
  const list = await dockerGet(socket, `/containers/json?all=1&filters=${labelFilter(project)}`);
  return Array.isArray(list) ? (list as RawContainer[]) : [];
}

/** Nombre de conteneurs d'AUTRES projets qui utilisent cette image (identifiant d'image). */
async function usedElsewhere(socket: string, project: string): Promise<Map<string, number>> {
  const all = await dockerGet(socket, "/containers/json?all=1");
  const out = new Map<string, number>();
  for (const c of Array.isArray(all) ? (all as (RawContainer & { Labels?: Record<string, string> })[]) : []) {
    if (c.Labels?.[PROJECT_LABEL] === project) continue;
    const id = str(c.ImageID, 100);
    if (id) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** Tailles des volumes d'après `/system/df` (lent sur de gros hôtes : facultatif, jamais bloquant). */
async function volumeSizes(socket: string): Promise<Map<string, number>> {
  try {
    const df = (await dockerGet(socket, "/system/df?type=volume", 30_000)) as { Volumes?: { Name?: unknown; UsageData?: { Size?: unknown } }[] };
    const out = new Map<string, number>();
    for (const v of df.Volumes ?? []) {
      const size = v.UsageData?.Size;
      if (typeof v.Name === "string" && typeof size === "number" && size >= 0) out.set(v.Name, size);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Ce que la suppression retirerait de l'hôte pour ce projet : lecture seule, rien n'est modifié. */
export async function planRemoval(socket: string, workspaceDir: string, msg: RemovalPlanMessage): Promise<Plan> {
  const project = msg.stack.project;
  const containers = await containersOf(socket, project);
  const elsewhere = await usedElsewhere(socket, project);

  const images = new Map<string, { ref: string; id: string; usedByOthers: number }>();
  const binds = new Set<string>();
  for (const c of containers) {
    const id = str(c.ImageID, 100);
    const ref = str(c.Image, 300);
    if (id && !images.has(id)) images.set(id, { ref: ref && !ref.startsWith("sha256:") ? ref : id, id, usedByOthers: elsewhere.get(id) ?? 0 });
    for (const m of Array.isArray(c.Mounts) ? (c.Mounts as { Type?: unknown; Source?: unknown }[]) : []) {
      if (m.Type === "bind" && typeof m.Source === "string") binds.add(m.Source.slice(0, 500));
    }
  }

  const networksRaw = await dockerGet(socket, `/networks?filters=${labelFilter(msg.stack.project)}`);
  const volumesRaw = (await dockerGet(socket, `/volumes?filters=${labelFilter(project)}`)) as { Volumes?: { Name?: unknown }[] | null };
  const sizes = await volumeSizes(socket);

  return {
    type: "removal_plan_result",
    planId: msg.planId,
    containers: containers.slice(0, MAX_LIST).map((c) => ({
      id: str(c.Id, 80),
      name: str(Array.isArray(c.Names) ? c.Names[0] : "", 200).replace(/^\//, ""),
      state: str(c.State, 30),
      image: str(c.Image, 300),
    })),
    running: containers.filter((c) => c.State === "running").length,
    networks: (Array.isArray(networksRaw) ? (networksRaw as { Id?: unknown; Name?: unknown }[]) : []).slice(0, 100).map((n) => ({ id: str(n.Id, 80), name: str(n.Name, 200) })),
    volumes: (volumesRaw.Volumes ?? []).slice(0, MAX_LIST).flatMap((v) => (typeof v.Name === "string" ? [{ name: v.Name.slice(0, 255), sizeBytes: sizes.get(v.Name) ?? null }] : [])),
    images: [...images.values()].slice(0, 100),
    binds: [...binds].slice(0, 100),
    workspace: await exists(join(workspaceDir, msg.stack.id)),
  };
}

type Log = (line: string) => void;

const detail = (body: unknown): string => (typeof body === "object" && body !== null && "message" in body ? str((body as { message?: unknown }).message, 200) : str(body, 200));

/**
 * Supprime de l'hôte, dans cet ordre : conteneurs (arrêtés) du projet, réseaux, volumes cochés, images cochées, dossier de
 * travail. Aucune commande libre : chaque élément est revérifié (étiquette du projet, usage par d'autres projets) avant
 * d'être retiré. Idempotent : un élément déjà absent n'est pas une erreur. Les échecs sont rapportés à la fin.
 */
export async function executeRemoval(socket: string, workspaceDir: string, msg: RunMessage, log: Log): Promise<void> {
  const removal = msg.removal;
  if (!removal) throw new Error("Détail de la suppression absent de la commande.");
  const project = msg.stack.project;
  const errors: string[] = [];

  const containers = await containersOf(socket, project);
  if (containers.some((c) => c.State === "running")) {
    throw new Error(`Un conteneur de « ${project} » est en marche : arrêtez l'application avant de la supprimer.`);
  }
  const projectImages = new Map<string, string>();
  for (const c of containers) {
    const id = str(c.ImageID, 100);
    const ref = str(c.Image, 300);
    if (id) projectImages.set(id, ref && !ref.startsWith("sha256:") ? ref : id);
  }

  for (const c of containers) {
    const id = str(c.Id, 80);
    const name = str(Array.isArray(c.Names) ? c.Names[0] : id, 200).replace(/^\//, "");
    const res = await dockerRequest(socket, "DELETE", `/containers/${encodeURIComponent(id)}?force=false&v=false`);
    if (res.status === 204 || res.status === 404) log(`Conteneur ${name} supprimé.`);
    else errors.push(`conteneur ${name} : ${detail(res.body) || `HTTP ${res.status}`}`);
  }

  if (removal.networks) {
    const networks = await dockerGet(socket, `/networks?filters=${labelFilter(project)}`);
    for (const n of Array.isArray(networks) ? (networks as { Id?: unknown; Name?: unknown }[]) : []) {
      const res = await dockerRequest(socket, "DELETE", `/networks/${encodeURIComponent(str(n.Id, 80))}`);
      if (res.status === 204 || res.status === 404) log(`Réseau ${str(n.Name, 200)} supprimé.`);
      else errors.push(`réseau ${str(n.Name, 200)} : ${detail(res.body) || `HTTP ${res.status}`}`);
    }
  }

  for (const name of removal.volumes) {
    let labels: Record<string, string> | null | undefined;
    try {
      labels = ((await dockerGet(socket, `/volumes/${encodeURIComponent(name)}`)) as { Labels?: Record<string, string> | null }).Labels;
    } catch {
      log(`Volume ${name} : déjà absent.`);
      continue;
    }
    if (labels?.[PROJECT_LABEL] !== project) {
      errors.push(`volume ${name} : n'appartient pas au projet « ${project} », non supprimé`);
      continue;
    }
    const res = await dockerRequest(socket, "DELETE", `/volumes/${encodeURIComponent(name)}`);
    if (res.status === 204 || res.status === 404) log(`Volume ${name} supprimé.`);
    else errors.push(`volume ${name} : ${detail(res.body) || `HTTP ${res.status}`}`);
  }

  if (removal.images.length > 0) {
    const elsewhere = await usedElsewhere(socket, project);
    for (const wanted of removal.images) {
      const entry = [...projectImages].find(([id, ref]) => id === wanted || ref === wanted);
      if (!entry) {
        errors.push(`image ${wanted} : n'est pas celle d'un conteneur du projet, non supprimée`);
        continue;
      }
      const [id, ref] = entry;
      if ((elsewhere.get(id) ?? 0) > 0) {
        log(`Image ${ref} conservée : utilisée par un autre projet.`);
        continue;
      }
      const res = await dockerRequest(socket, "DELETE", `/images/${encodeURIComponent(ref)}?force=false`);
      if (res.status === 200 || res.status === 404) log(`Image ${ref} supprimée.`);
      else errors.push(`image ${ref} : ${detail(res.body) || `HTTP ${res.status}`}`);
    }
  }

  if (removal.workspace) {
    const base = resolve(workspaceDir);
    for (const dir of [resolve(base, msg.stack.id), resolve(base, `${msg.stack.id}.staging`)]) {
      // Jamais en dehors de l'espace de travail, quoi que contienne l'identifiant.
      if (!dir.startsWith(base + sep) || dir === base) continue;
      if (await exists(dir)) {
        await rm(dir, { recursive: true, force: true });
        log(`Dossier ${dir} supprimé.`);
      }
    }
  }

  if (errors.length > 0) throw new Error(`Suppression incomplète : ${errors.join(" ; ")}`.slice(0, 4000));
  log("Suppression terminée sur l'hôte.");
}
