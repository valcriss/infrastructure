import { encodeDotenvExport, type ExportedVariable } from "@infra/shared";
import { strToU8, zipSync } from "fflate";

export interface ExportInput {
  stackName: string;
  /** Révision exportée (la révision active : celle qui est déployée). */
  revision: number;
  deployedAt: Date | null;
  /** Dernière révision enregistrée, si elle est plus récente que la révision exportée. */
  newerRevision: number | null;
  exportedBy: string;
  exportedAt: Date;
  includeSecrets: boolean;
  compose: string;
  variables: Record<string, { value: string; sensitive: boolean }>;
  files: Record<string, string>;
  sensitiveFiles: string[];
}

export interface StackExport {
  filename: string;
  zip: Uint8Array;
  /** Variables sensibles et fichiers sensibles laissés de côté (vide si les secrets sont inclus). */
  omitted: { variables: string[]; files: string[] };
}

const fmt = (d: Date): string => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * Archive ZIP d'une stack : `docker-compose.yml`, `.env`, fichiers associés (arborescence conservée) et un LISEZMOI.
 * Les valeurs sensibles (variables et fichiers) n'y figurent que si `includeSecrets` ; sinon la ligne du `.env` est
 * laissée vide avec un commentaire, et le fichier est omis (et listé dans le LISEZMOI).
 */
export function buildStackExport(input: ExportInput): StackExport {
  const variables: ExportedVariable[] = Object.entries(input.variables).map(([name, v]) => ({ name, value: v.sensitive && !input.includeSecrets ? null : v.value }));
  const omittedVariables = variables.filter((v) => v.value === null).map((v) => v.name).sort();
  const sensitiveFiles = new Set(input.sensitiveFiles);
  const filePaths = Object.keys(input.files).sort();
  const omittedFiles = input.includeSecrets ? [] : filePaths.filter((p) => sensitiveFiles.has(p));

  const entries: Record<string, Uint8Array> = {
    "docker-compose.yml": strToU8(input.compose),
    ".env": strToU8(encodeDotenvExport(variables, `# Exporté par la console : révision ${input.revision} de « ${input.stackName} » le ${fmt(input.exportedAt)}.`)),
  };
  for (const path of filePaths) {
    if (omittedFiles.includes(path)) continue;
    entries[path] = strToU8(input.files[path] ?? "");
  }

  const lines = [
    `Export de la stack « ${input.stackName} »`,
    "",
    `Révision exportée : ${input.revision} (révision active, celle qui est déployée${input.deployedAt ? ` depuis le ${fmt(input.deployedAt)}` : ""}).`,
    ...(input.newerRevision !== null ? [`Une révision plus récente (${input.newerRevision}) est enregistrée mais n'est pas déployée : elle n'est pas incluse.`] : []),
    `Exporté le ${fmt(input.exportedAt)} par ${input.exportedBy}.`,
    "",
    "Contenu",
    "  docker-compose.yml  configuration de la stack",
    "  .env                variables d'interpolation (${NOM} du Compose)",
    ...filePaths.filter((p) => !omittedFiles.includes(p)).map((p) => `  ${p}`),
    "",
    "Utilisation (depuis ce dossier)",
    `  docker compose --project-name ${input.stackName} up -d`,
    "",
    input.includeSecrets
      ? "Valeurs sensibles : INCLUSES. Ce dossier contient des secrets en clair : protégez-le et supprimez-le après usage."
      : "Valeurs sensibles : NON exportées.",
    ...(omittedVariables.length ? ["", "Variables à renseigner dans .env (lignes vides) :", ...omittedVariables.map((n) => `  ${n}`)] : []),
    ...(omittedFiles.length ? ["", "Fichiers sensibles non exportés (à recréer) :", ...omittedFiles.map((p) => `  ${p}`)] : []),
    "",
    "Attention : le Compose peut référencer des chemins propres à l'hôte d'origine (volumes, réseaux externes) à adapter avant de le lancer ailleurs.",
    "",
  ];
  entries["LISEZMOI.txt"] = strToU8(lines.join("\n"));

  return {
    filename: `${input.stackName}-r${input.revision}${input.includeSecrets ? "-avec-secrets" : ""}.zip`,
    zip: zipSync(entries, { level: 6 }),
    omitted: { variables: omittedVariables, files: omittedFiles },
  };
}
