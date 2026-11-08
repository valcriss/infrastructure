import { isMap, isPair, isScalar, parseDocument, visit } from "yaml";
import { ComposeEditError, detectStyle } from "./compose-edit.js";

export interface CleanResult {
  compose: string;
  /** Nombre de commentaires supprimés. */
  comments: number;
  /** Une directive `version` de premier niveau a été supprimée (obsolète dans la spécification Compose). */
  versionRemoved: string | null;
  changed: boolean;
}

/**
 * « Nettoyer le contenu » : supprime les commentaires et la directive `version`, et place une ligne vide entre les
 * grandes sections et entre les services. Le reste (ordre, valeurs, guillemets, alias) est conservé ; les lignes vides
 * existantes sont remplacées par cette règle unique.
 */
export function cleanCompose(text: string): CleanResult {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le YAML est invalide : corrigez-le avant de nettoyer.");
  const root = doc.contents;
  if (!isMap(root)) throw new ComposeEditError("unsupported_structure", "Le fichier Compose doit être un objet YAML.");

  let comments = 0;
  const drop = (n: { comment?: string | null | undefined; commentBefore?: string | null | undefined; spaceBefore?: boolean | undefined }): void => {
    if (n.comment) comments += n.comment.split("\n").length;
    if (n.commentBefore) comments += n.commentBefore.split("\n").length;
    delete n.comment;
    delete n.commentBefore;
    delete n.spaceBefore;
  };
  if (doc.commentBefore) comments += doc.commentBefore.split("\n").length;
  if (doc.comment) comments += doc.comment.split("\n").length;
  doc.commentBefore = null;
  doc.comment = null;
  visit(doc, {
    Node(_key, node) {
      drop(node as never);
    },
    Pair(_key, pair) {
      // Les commentaires et lignes vides d'une entrée sont portés par sa clé et sa valeur.
      if (isScalar(pair.key)) drop(pair.key);
    },
  });

  let versionRemoved: string | null = null;
  const versionPair = root.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === "version");
  if (versionPair) {
    versionRemoved = isScalar(versionPair.value) ? String(versionPair.value.value) : "";
    root.items = root.items.filter((p) => p !== versionPair);
  }

  // Une ligne vide avant chaque section sauf la première, et avant chaque service sauf le premier.
  const blankBefore = (items: unknown[]): void => {
    items.forEach((p, i) => {
      if (i > 0 && isPair(p) && isScalar(p.key)) p.key.spaceBefore = true;
    });
  };
  blankBefore(root.items);
  const services = root.get("services", true);
  if (isMap(services)) blankBefore(services.items);

  const style = detectStyle(text);
  const compose = doc.toString({ indent: style.indent, indentSeq: style.indentSeq, lineWidth: 0, flowCollectionPadding: false });
  return { compose, comments, versionRemoved, changed: compose !== text };
}
