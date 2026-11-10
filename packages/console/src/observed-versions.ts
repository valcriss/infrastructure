import type { Container, ImageInfo, Inventory } from "@infra/shared";
import type { Pool } from "./db.js";
import { hiddenProjects } from "./display.js";

/** Versions conservées par service : au-delà, les plus anciennes sont supprimées. */
export const MAX_VERSIONS_PER_SERVICE = 100;

export interface ObservedVersion {
  id: string;
  service: string;
  image: string;
  imageId: string;
  digest: string | null;
  observedAt: string;
}

/** Version courante d'un service : celle du premier conteneur (en marche de préférence, puis par nom). */
function currentOf(containers: Container[]): Container {
  const sorted = [...containers].sort(
    (a, b) => Number(b.state === "running") - Number(a.state === "running") || (a.names[0] ?? a.id).localeCompare(b.names[0] ?? b.id),
  );
  return sorted[0] as Container;
}

function digestOf(imageId: string, images: ImageInfo[] | undefined): string | null {
  const ref = images?.find((i) => i.id === imageId)?.repoDigests[0];
  return ref?.includes("@") ? ref.slice(ref.indexOf("@") + 1) : null;
}

/**
 * Enregistre les changements de version des projets Compose non gérés d'un hôte. Appelé à chaque inventaire :
 * rien n'est écrit tant que l'image et son contenu (identifiant local) n'ont pas changé. Les projets gérés par une
 * stack et ceux de la console elle-même sont ignorés.
 */
export async function recordObservedVersions(pool: Pool, hostId: string, inventory: Inventory): Promise<void> {
  const hidden = await hiddenProjects(pool);
  const managed = await pool.query<{ name: string }>("SELECT name FROM stacks WHERE host_id = $1", [hostId]);
  const skip = new Set([...hidden, ...managed.rows.map((r) => r.name)]);

  const byService = new Map<string, Container[]>();
  for (const c of inventory.containers) {
    if (!c.composeProject || !c.composeService || skip.has(c.composeProject)) continue;
    const key = JSON.stringify([c.composeProject, c.composeService]);
    byService.set(key, [...(byService.get(key) ?? []), c]);
  }
  if (byService.size === 0) return;

  const latest = await pool.query<{ project: string; service: string; image: string; image_id: string }>(
    `SELECT DISTINCT ON (project, service) project, service, image, image_id
       FROM observed_versions WHERE host_id = $1 ORDER BY project, service, observed_at DESC, id`,
    [hostId],
  );
  const known = new Map(latest.rows.map((r) => [JSON.stringify([r.project, r.service]), r]));

  for (const [key, containers] of byService) {
    const [project, service] = JSON.parse(key) as [string, string];
    const c = currentOf(containers);
    const prev = known.get(key);
    if (prev && prev.image === c.image && prev.image_id === c.imageId) continue;
    await pool.query(
      "INSERT INTO observed_versions (host_id, project, service, image, image_id, digest) VALUES ($1, $2, $3, $4, $5, $6)",
      [hostId, project, service, c.image, c.imageId, digestOf(c.imageId, inventory.images)],
    );
    await pool.query(
      `DELETE FROM observed_versions WHERE id IN (
         SELECT id FROM observed_versions WHERE host_id = $1 AND project = $2 AND service = $3
          ORDER BY observed_at DESC, id OFFSET $4)`,
      [hostId, project, service, MAX_VERSIONS_PER_SERVICE],
    );
  }
}

export async function listObservedVersions(pool: Pool, hostId: string, project: string): Promise<ObservedVersion[]> {
  const { rows } = await pool.query<{ id: string; service: string; image: string; image_id: string; digest: string | null; observed_at: Date }>(
    `SELECT id, service, image, image_id, digest, observed_at FROM observed_versions
      WHERE host_id = $1 AND project = $2 ORDER BY observed_at DESC, id LIMIT 500`,
    [hostId, project],
  );
  return rows.map((r) => ({ id: r.id, service: r.service, image: r.image, imageId: r.image_id, digest: r.digest, observedAt: r.observed_at.toISOString() }));
}
