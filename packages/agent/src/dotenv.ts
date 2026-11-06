import { validateVariableName, validateVariableValue } from "@infra/shared";

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
