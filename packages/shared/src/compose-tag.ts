import { isAlias, isMap, isScalar, parseDocument } from "yaml";
import { ComposeEditError, detectStyle } from "./compose-edit.js";

/**
 * Change l'étiquette de l'image d'un service (`ghost:bookworm` → `ghost:6.75-alpine`) en conservant le reste du
 * document. Refuse une image paramétrée (variables), épinglée par digest ou sans « image » simple.
 */
export function editServiceImageTag(text: string, service: string, tag: string): { compose: string; from: string; to: string } {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) throw new ComposeEditError("unsupported_structure", "Étiquette invalide.");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  const services = doc.get("services", true);
  if (!isMap(services)) throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  const svc = services.get(service, true);
  if (!isMap(svc)) throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  if (svc.has("<<")) throw new ComposeEditError("unsupported_structure", "Le service utilise une clé de fusion « << » : modification refusée.");
  if (svc.has("build")) throw new ComposeEditError("unsupported_structure", "Ce service est construit localement : modifiez son Dockerfile plutôt que son étiquette.");
  const image = svc.get("image", true);
  if (isAlias(image) || !isScalar(image) || typeof image.value !== "string") {
    throw new ComposeEditError("unsupported_structure", "Le service n'a pas d'« image » simple à modifier.");
  }
  const from = image.value;
  if (from.includes("$")) throw new ComposeEditError("unsupported_structure", "L'image est paramétrée par une variable : modifiez la variable ou le Compose à la main.");
  if (from.includes("@")) throw new ComposeEditError("unsupported_structure", "L'image est épinglée par digest : modifiez-la à la main.");
  const lastSlash = from.lastIndexOf("/");
  const colon = from.indexOf(":", lastSlash + 1);
  const to = `${colon === -1 ? from : from.slice(0, colon)}:${tag}`;
  if (to === from) throw new ComposeEditError("unsupported_structure", "C'est déjà l'étiquette actuelle.");
  image.value = to;
  const style = detectStyle(text);
  return {
    from,
    to,
    compose: doc.toString({
      indent: style.indent,
      indentSeq: style.indentSeq,
      ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
      lineWidth: 0,
    }),
  };
}

/** Image (texte) d'un service dans un Compose ; null si le service ou son image est absent ou illisible. */
export function composeServiceImage(text: string, service: string): string | null {
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length > 0) return null;
    const services = doc.get("services", true);
    if (!isMap(services)) return null;
    const svc = services.get(service, true);
    if (!isMap(svc)) return null;
    const image = svc.get("image", true);
    return isScalar(image) && typeof image.value === "string" ? image.value : null;
  } catch {
    return null;
  }
}
