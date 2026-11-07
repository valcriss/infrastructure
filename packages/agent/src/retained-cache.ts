import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Entrées du cache de build que Docker a refusé de supprimer alors qu'elles remplissaient les critères du nettoyage
 * (une entrée plus récente ou une image en dépend, référence interne…). On s'en souvient pour ne plus les proposer :
 * sinon un aperçu afficherait indéfiniment « N éléments à supprimer » après chaque nettoyage. La liste est conservée
 * dans le dossier d'état de l'agent et épurée des entrées qui n'existent plus.
 */
export class RetainedBuildCache {
  private ids: Set<string> | null = null;

  constructor(private readonly file: string | null) {}

  async load(): Promise<Set<string>> {
    if (this.ids) return this.ids;
    this.ids = new Set();
    if (!this.file) return this.ids;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as unknown;
      if (Array.isArray(data)) for (const id of data) if (typeof id === "string" && id.length <= 80) this.ids.add(id);
    } catch {
      /* pas encore de fichier : rien n'est retenu */
    }
    return this.ids;
  }

  private async save(): Promise<void> {
    if (!this.file || !this.ids) return;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.ids].slice(0, 20_000)), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch {
      /* la mémoire reste valable jusqu'au redémarrage de l'agent */
    }
  }

  async add(ids: string[]): Promise<void> {
    const set = await this.load();
    let changed = false;
    for (const id of ids) {
      if (set.has(id)) continue;
      set.add(id);
      changed = true;
    }
    if (changed) await this.save();
  }

  /** Oublie les entrées qui n'existent plus dans le cache de Docker. */
  async forgetMissing(existing: Set<string>): Promise<void> {
    const set = await this.load();
    let changed = false;
    for (const id of [...set]) {
      if (existing.has(id)) continue;
      set.delete(id);
      changed = true;
    }
    if (changed) await this.save();
  }
}
