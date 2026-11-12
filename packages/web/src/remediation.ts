import type { RemediationStatus } from "./api";

/** Étapes d'un correctif, dans l'ordre, avec leur libellé. */
export const STAGES: { status: RemediationStatus; label: string }[] = [
  { status: "queued", label: "En attente" },
  { status: "preparing", label: "Préparation" },
  { status: "scanning_before", label: "Scan avant" },
  { status: "patching", label: "Correctif" },
  { status: "scanning_after", label: "Scan après" },
  { status: "verifying", label: "Vérification" },
];

const FINAL_LABEL: Record<string, string> = {
  validated: "Validé",
  partial: "Partiel",
  rejected: "Refusé",
  failed: "Échec",
  unknown: "Indéterminé",
  cancelled: "Annulé",
};

/** Libellé court d'un statut (étape en cours ou verdict). */
export function statusLabel(status: RemediationStatus): string {
  return FINAL_LABEL[status] ?? STAGES.find((s) => s.status === status)?.label ?? status;
}

/** Position de l'étape en cours (0 = en attente) ; -1 si le correctif est terminé. */
export function stageIndex(status: RemediationStatus): number {
  return STAGES.findIndex((s) => s.status === status);
}

/** Classes de la pastille d'un statut. */
export function statusClass(status: RemediationStatus): string {
  switch (status) {
    case "validated": return "bg-green-100 text-green-800";
    case "partial": return "bg-amber-100 text-amber-800";
    case "rejected":
    case "failed": return "bg-red-100 text-red-800";
    case "unknown": return "bg-orange-100 text-orange-800";
    case "cancelled": return "bg-slate-100 text-slate-600";
    default: return "bg-blue-100 text-blue-800";
  }
}

/** Le saut de version d'un paquet change-t-il son numéro majeur ? (signalé dans le rapport) */
export function majorJump(from: string, to: string): boolean {
  const major = (v: string): string | null => /^(\d+)/.exec(v.replace(/^[^0-9]*/, ""))?.[1] ?? null;
  const a = major(from);
  const b = major(to);
  return a !== null && b !== null && a !== b;
}

/** Correctif le plus récent de chaque contenu d'image (identifiant + plateforme). */
export function latestByImage<T extends { imageId: string; platform: string; createdAt: string }>(jobs: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const j of jobs) {
    const key = `${j.imageId}|${j.platform}`;
    const cur = out.get(key);
    if (!cur || j.createdAt > cur.createdAt) out.set(key, j);
  }
  return out;
}

/** L'image d'un service vient-elle du registre privé de la console (image corrigée) ? */
export function isPatchedRef(ref: string, registryHost: string | null): boolean {
  return registryHost !== null && ref.startsWith(`${registryHost}/patched/`);
}
