/**
 * Le statut de santé n'a de sens que pour un conteneur en marche : Docker conserve le dernier statut connu après l'arrêt
 * (parfois « en échec » alors que le dernier test a réussi). Pour un conteneur arrêté, on n'affiche donc aucun état de santé.
 */
export function healthApplies(state: string): boolean {
  return state === "running";
}
