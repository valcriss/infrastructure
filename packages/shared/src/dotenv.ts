import { validateVariableName, validateVariableValue } from "./stack.js";

/**
 * Encode une valeur pour un fichier `.env` Compose, sans interpolation :
 * - sans apostrophe : guillemets simples (tout est littéral) ;
 * - sinon : guillemets doubles avec échappement de `\`, `"` et `$`.
 * Comportement vérifié contre `docker compose config`.
 */
export function encodeDotenvValue(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
  return `"${escaped}"`;
}

/** `.env` écrit par l'agent sur l'hôte lors d'un déploiement. */
export function encodeDotenv(variables: Record<string, string>): string {
  const lines = ["# Généré par la console : ne pas modifier à la main."];
  for (const name of Object.keys(variables).sort()) {
    const value = variables[name] ?? "";
    const err = validateVariableName(name) ?? validateVariableValue(value);
    if (err) throw new Error(`Variable « ${name} » invalide : ${err}`);
    lines.push(`${name}=${encodeDotenvValue(value)}`);
  }
  return lines.join("\n") + "\n";
}

export interface ExportedVariable {
  name: string;
  /** Valeur ; null pour une variable sensible qu'on n'exporte pas (la ligne est laissée vide, à renseigner). */
  value: string | null;
}

/**
 * `.env` exporté : même encodage que celui de l'agent. Une variable sans valeur (sensible, non exportée) est écrite
 * vide, précédée d'un commentaire, pour que Compose l'accepte et que l'utilisateur sache quoi renseigner.
 */
export function encodeDotenvExport(variables: ExportedVariable[], header: string): string {
  const lines = [header];
  for (const v of [...variables].sort((a, b) => a.name.localeCompare(b.name))) {
    const err = validateVariableName(v.name) ?? (v.value === null ? null : validateVariableValue(v.value));
    if (err) throw new Error(`Variable « ${v.name} » invalide : ${err}`);
    if (v.value === null) {
      lines.push(`# ${v.name} : valeur sensible non exportée, à renseigner`);
      lines.push(`${v.name}=`);
    } else {
      lines.push(`${v.name}=${encodeDotenvValue(v.value)}`);
    }
  }
  return lines.join("\n") + "\n";
}
