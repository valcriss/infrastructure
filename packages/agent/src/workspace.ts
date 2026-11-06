import { validateFilePath } from "@infra/shared";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const MANIFEST = ".managed.json";

export interface StackFiles {
  compose: string;
  env: string;
  files: Record<string, string>;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Le dossier a déjà été géré par la console (marqueur de propriété). */
export const isManaged = (dir: string): Promise<boolean> => exists(join(dir, MANIFEST));

async function readManifest(dir: string): Promise<string[]> {
  try {
    const data = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as { files?: unknown };
    return Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Crée les dossiers parents d'un fichier en refusant tout lien symbolique ou
 * élément non-dossier sur le chemin : un lien posé dans l'espace de travail ne
 * doit jamais permettre d'écrire hors du dossier de la stack.
 */
async function ensureSafeParents(root: string, target: string): Promise<void> {
  const rel = target.slice(root.length + 1);
  const segments = rel.split(sep).slice(0, -1);
  let current = root;
  for (const seg of segments) {
    current = join(current, seg);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) throw new Error(`Lien symbolique refusé dans le chemin : ${seg}`);
      if (!st.isDirectory()) throw new Error(`Un fichier occupe le chemin d'un dossier : ${seg}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await mkdir(current, { mode: 0o755 });
    }
  }
}

async function writeAtomic(root: string, rel: string, content: string, mode: number): Promise<void> {
  const target = resolve(root, rel);
  if (!target.startsWith(root + sep)) throw new Error(`Chemin hors du dossier géré : ${rel}`);
  await ensureSafeParents(root, target);
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink() || st.isDirectory()) {
      throw new Error(`Cible refusée (lien symbolique ou dossier) : ${rel}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Écriture dans un fichier temporaire exclusif puis renommage : le renommage
  // remplace l'entrée sans jamais suivre un lien présent à la destination.
  const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, content, { flag: "wx", mode });
  await rename(tmp, target);
}

/**
 * Écrit les fichiers d'une révision dans `dir` et retire ceux qu'une révision
 * précédente avait écrits et que celle-ci ne contient plus. Les fichiers qui
 * n'appartiennent pas à la console (données d'application) ne sont jamais
 * supprimés.
 */
export async function syncStackDir(dir: string, content: StackFiles): Promise<void> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true, mode: 0o755 });

  for (const rel of Object.keys(content.files)) {
    const err = validateFilePath(rel);
    if (err) throw new Error(`Chemin invalide « ${rel} » : ${err}`);
  }

  await writeAtomic(root, "compose.yaml", content.compose, 0o644);
  // Le .env peut contenir des secrets : lisible par le seul propriétaire.
  await writeAtomic(root, ".env", content.env, 0o600);
  for (const [rel, body] of Object.entries(content.files)) {
    await writeAtomic(root, rel, body, 0o644);
  }

  const previous = await readManifest(root);
  const current = new Set(Object.keys(content.files));
  for (const rel of previous) {
    if (current.has(rel) || validateFilePath(rel)) continue;
    const target = resolve(root, rel);
    if (!target.startsWith(root + sep)) continue;
    try {
      await unlink(target);
    } catch {
      continue;
    }
    // Retire les dossiers devenus vides, sans jamais remonter au-delà de la racine.
    for (let d = dirname(target); d !== root && d.startsWith(root + sep); d = dirname(d)) {
      try {
        await rmdir(d);
      } catch {
        break;
      }
    }
  }
  await writeFile(join(root, MANIFEST), JSON.stringify({ files: [...current].sort() }), { mode: 0o644 });
}
