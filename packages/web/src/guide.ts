import type { RemediationEligibility, RemediationJob, RemediationTarget } from "./api";

/** Messages qui guident l'utilisateur à chaque étape du correctif d'une image : quoi faire ensuite, et où. */
export type Tone = "info" | "success" | "warning" | "error";
export interface Hint {
  tone: Tone;
  title: string;
  text: string;
  /** Lien interne vers l'écran où poursuivre. */
  to?: string;
  action?: string;
}

// --- Avant de lancer : ce qui manque ---------------------------------------------------------------------------

/** Quoi faire d'après l'éligibilité de l'image (scan manquant, distribution, registre, hôte…). */
export function eligibilityHint(e: RemediationEligibility | null, canOperate: boolean, hasJobs = false): Hint | null {
  if (!e) return null;
  switch (e.reason) {
    case "no_scan":
      return { tone: "warning", title: "Étape 1 : scannez l'image", text: "Un correctif part du dernier scan réussi de l'image. Fermez cette fenêtre, cliquez « Scanner » sur la ligne de l'image, puis revenez ici." };
    case "unsupported_os":
      return { tone: "warning", title: "Distribution non prise en charge", text: "Seules les images Alpine et Debian peuvent être corrigées automatiquement. Pour une autre distribution, la meilleure voie est une version officielle plus récente de l'image (onglet « Sécurité et versions » de l'application)." };
    case "eol":
      return { tone: "warning", title: "Distribution en fin de vie", text: "Plus aucun correctif n'est publié pour cette version : un correctif local ne serait pas fiable. Migrez vers une version supportée de l'image (onglet « Sécurité et versions » de l'application)." };
    case "nothing_fixable":
      return { tone: "info", title: "Rien à corriger pour le moment", text: "Aucune vulnérabilité n'a de correctif publié dans les paquets du système : un correctif local n'apporterait rien. Revenez après la prochaine mise à jour de l'image, ou après un nouveau scan." };
    case "infrastructure":
      return { tone: "info", title: "Image d'infrastructure : pas de correctif local", text: "Cette image fait tourner le registre, Traefik, la console ou son agent. La stocker dans le registre créerait une dépendance circulaire : après un nettoyage de l'hôte, rien ne pourrait plus redémarrer. Mettez-la à jour vers une version officielle (« Vérifier les mises à jour », onglet « Sécurité et versions »)." };
    case "app_only":
      return { tone: "warning", title: "Vulnérabilités dans les dépendances de l'application", text: "Elles ne se corrigent pas au niveau de l'image : mettez à jour l'application elle-même, ou choisissez une version officielle plus récente de l'image." };
    default:
      break;
  }
  if (e.activeJob) return { tone: "info", title: "Un correctif est déjà en cours pour cette image", text: "Suivez-le ci-dessous : vous pouvez fermer cette fenêtre, il continue sur l'hôte." };
  if (!e.registry.ready) {
    return { tone: "warning", title: "Étape 2 : préparez le registre privé", text: `${e.registry.reason ?? "Le registre privé n'est pas prêt."} Il reçoit les images corrigées, que vos hôtes téléchargeront ensuite.`, to: "/settings?tab=registry", action: "Ouvrir Paramètres → Registry" };
  }
  if (!e.hosts.some((h) => h.online && h.capable)) {
    const offline = e.hosts.find((h) => !h.online);
    const old = e.hosts.find((h) => h.online && !h.capable);
    return {
      tone: "warning",
      title: "Aucun hôte disponible pour exécuter le correctif",
      text: old ? `L'agent de « ${old.name} » est trop ancien : mettez-le à jour (voir le guide d'exploitation).` : offline ? `L'hôte « ${offline.name} » est hors ligne : démarrez-le ou attendez sa reconnexion.` : "Aucun hôte ne porte cette image.",
      to: "/hosts",
      action: "Voir les hôtes",
    };
  }
  if (!canOperate) return { tone: "info", title: "Lecture seule", text: "Seul un opérateur peut lancer un correctif. Vous pouvez consulter les résultats existants." };
  if (hasJobs) return { tone: "info", title: "Un nouveau correctif est possible", text: "Utile après un nouveau scan ou si le contenu de l'image a changé. Les correctifs précédents restent dans l'historique ci-dessous." };
  return { tone: "success", title: "Prêt : lancez le correctif", text: "Comptez de une à quelques minutes. Vous pouvez fermer la fenêtre pendant l'exécution : rien n'est modifié sur vos applications, et rien n'est déployé." };
}

// --- Pendant et après : l'étape suivante -----------------------------------------------------------------------

const RUNNING = ["preparing", "scanning_before", "patching", "scanning_after", "verifying"];

/** Quoi faire ensuite d'après l'état du correctif affiché. `targets` : services qui utilisent l'image corrigée. */
export function jobHint(job: RemediationJob | null, targets: RemediationTarget[]): Hint | null {
  if (!job) return null;
  if (job.cancelRequested) return { tone: "info", title: "Arrêt demandé", text: "L'agent interrompt le travail et supprime ses conteneurs temporaires. Le correctif passe à « annulé » dès qu'il le confirme." };
  if (job.status === "queued") return { tone: "info", title: "En attente", text: "Un correctif à la fois s'exécute par hôte. Celui-ci démarre dès que l'hôte est libre (et en ligne). Vous pouvez l'annuler tant qu'il n'a pas commencé." };
  if (RUNNING.includes(job.status)) return { tone: "info", title: "Correctif en cours", text: "Vous pouvez fermer cette fenêtre : il continue sur l'hôte et apparaîtra ici à son terme. Vos applications ne sont pas touchées." };
  if (job.status === "unknown") {
    return { tone: "warning", title: "Résultat indéterminé : à vérifier", text: "La connexion à l'agent a été perdue : le travail a pu aboutir ou non. 1) Regardez dans « Images du registre » si l'image corrigée existe ; 2) puis « Abandonner » ce correctif et relancez-en un.", to: "/settings?tab=registry", action: "Ouvrir Paramètres → Registry" };
  }
  if (job.status === "failed") {
    return { tone: "error", title: "Le correctif a échoué", text: "Aucun changement n'a été appliqué. Causes fréquentes : registre injoignable (testez l'accès dans Paramètres → Registry), espace disque insuffisant sur l'hôte, ou BuildKit qui ne démarre pas (sur Ubuntu 24.04, voir « Correctifs d'images » du guide d'exploitation). Corrigez la cause puis relancez." };
  }
  if (job.status === "cancelled") return { tone: "info", title: "Correctif annulé", text: "Rien n'a été appliqué. Ce qui a été publié dans le registre y reste ; vous pouvez le supprimer depuis « Images du registre ». Relancez un correctif quand vous le souhaitez." };
  if (job.status === "rejected") {
    const why = job.bilan?.reasons[0];
    return { tone: "warning", title: "Correctif refusé : l'image n'est pas utilisable", text: `${why ? `${why} ` : ""}Le verdict vient d'une comparaison avant / après, jamais du moteur : l'image d'origine n'est pas modifiée. Attendez une version officielle plus récente, ou mettez à jour l'application.` };
  }
  if (job.imageDeleted) return { tone: "warning", title: "Image corrigée supprimée du registre", text: "Elle ne peut plus être utilisée. Relancez un correctif pour en produire une nouvelle." };
  const review = job.automatic && !job.reviewedAt ? "Ce correctif a été préparé automatiquement : relisez le bilan ci-dessous, puis « Marquer comme relu ». " : "";
  const usable = targets.filter((t) => t.canApply);
  const applied = job.applied[0];
  if (applied) {
    return { tone: "success", title: "Dernière étape : déployez l'application", text: `${review}La révision ${applied.revision} de « ${applied.stackName} » contient l'image corrigée mais n'est pas déployée. Ouvrez l'application, relisez les changements, puis déployez ; vérifiez ensuite que le service fonctionne.`, to: `/stacks/${applied.stackId}`, action: `Ouvrir « ${applied.stackName} »` };
  }
  const partial = job.status === "partial" ? "Des vulnérabilités corrigeables subsistent (verdict « partiel ») : l'image reste utilisable, mais vous devrez le confirmer explicitement. " : "";
  if (usable.length > 0) {
    return { tone: job.status === "partial" ? "warning" : "success", title: "Étape suivante : utiliser l'image corrigée", text: `${review}${partial}Choisissez un service ci-dessous : une nouvelle révision de l'application est créée, sans la déployer. Vous relirez les changements puis déploierez vous-même.` };
  }
  if (targets.length > 0) {
    return { tone: "info", title: "Cette image n'est pas utilisable telle quelle par vos applications", text: `${review}Les services concernés sont listés ci-dessous avec la raison pour laquelle l'image corrigée ne peut pas leur être proposée (variable partagée, application générée par la console, etc.).` };
  }
  return { tone: "info", title: "Image corrigée prête, aucune application ne l'utilise", text: `${review}${partial}Aucun service d'une application gérée n'utilise actuellement cette image exacte. Utilisez la référence immuable ci-dessous là où vous en avez besoin.` };
}

// --- Parcours d'ensemble (page Images) -----------------------------------------------------------------

/** Ce que la page Registry sait de la mise en place (sous-ensemble de la réponse de `/api/v1/settings/registry`). */
export interface RegistrySetup {
  traefik: { available: boolean; deployed?: boolean };
  application: { deployed?: boolean; missing?: true } | null;
  separated: boolean;
}

export interface GuideStep {
  id: string;
  title: string;
  text: string;
  done: boolean;
  to?: string;
  action?: string;
}

export interface GuideInput {
  registry: RegistrySetup | null;
  scannedImages: number;
  jobs: number;
  toReview: number;
  applied: number;
}

/** Les étapes du parcours, avec leur état : 1-2 mises en place du registre, 3-7 usage courant. */
export function guideSteps(g: GuideInput): GuideStep[] {
  const r = g.registry;
  const traefikOk = !!r?.traefik.available && !!r.traefik.deployed;
  const app = r?.application && !("missing" in r.application) ? r.application : null;
  const registryOk = !!app?.deployed;
  return [
    { id: "traefik", title: "Exposer un registre", text: traefikOk ? "Traefik est déployé : il sert le registre en HTTPS." : "Le registre privé passe par Traefik (certificat HTTPS). Créez et déployez d'abord l'application Traefik.", done: traefikOk, to: "/settings?tab=traefik", action: "Paramètres → Traefik" },
    { id: "registry", title: "Créer et déployer le registre", text: registryOk ? (r?.separated ? "Registre déployé, comptes séparés (lecture / publication)." : "Registre déployé. Conseil : « Séparer les comptes » pour ne transmettre aux hôtes qu'un compte en lecture seule.") : "Créez l'application registry, relisez ses fichiers, déployez-la, puis « Tester l'accès ».", done: registryOk, to: "/settings?tab=registry", action: "Paramètres → Registry" },
    { id: "scan", title: "Scanner l'image", text: g.scannedImages > 0 ? `${g.scannedImages} image(s) scannée(s).` : "Un correctif part d'un scan réussi : cliquez « Scanner » sur une image.", done: g.scannedImages > 0 },
    { id: "patch", title: "Lancer le correctif", text: g.jobs > 0 ? `${g.jobs} correctif(s) lancé(s).` : "Cliquez « Corriger » sur une image éligible : l'agent la copie dans le registre, la corrige et la vérifie.", done: g.jobs > 0 },
    { id: "review", title: "Relire le bilan", text: g.toReview > 0 ? `${g.toReview} correctif(s) préparé(s) automatiquement attendent votre relecture.` : "Vérifiez les CVE corrigées, les paquets modifiés et la vérification de démarrage avant d'utiliser l'image.", done: g.jobs > 0 && g.toReview === 0 },
    { id: "apply", title: "Utiliser l'image corrigée", text: g.applied > 0 ? `${g.applied} application(s) ont une révision avec l'image corrigée.` : "Dans le bilan, choisissez un service : une révision non déployée est créée.", done: g.applied > 0 },
    { id: "deploy", title: "Déployer, puis nettoyer", text: "Le déploiement reste une action explicite de l'application. Les anciennes images se nettoient dans Paramètres → Registry (rétention, ramasse-miettes).", done: false, to: "/settings?tab=registry", action: "Nettoyer le registre" },
  ];
}

/** Première étape non terminée (la prochaine à faire). */
export function currentStep(steps: GuideStep[]): GuideStep | null {
  return steps.find((s) => !s.done && s.id !== "deploy") ?? null;
}

// --- Page Registry ---------------------------------------------------------------------------------------------

export interface RegistryProbe { ready: boolean; dns: { ok: boolean }; tls: { ok: boolean }; anonymous: { ok: boolean }; authenticated: { ok: boolean }; pullRead?: { ok: boolean }; pullWriteDenied?: { ok: boolean }; publishWrite?: { ok: boolean } }

/** Prochaine étape de la mise en place du registre, d'après son état et le dernier test d'accès. */
export function registryNextStep(setup: { traefik: { available: boolean; deployed?: boolean; production?: boolean }; hasApplication: boolean; deployed: boolean; separated: boolean; managed: boolean }, probe: RegistryProbe | null): Hint {
  if (!setup.traefik.available) return { tone: "warning", title: "Étape 1 sur 5 : créez l'application Traefik", text: "Le registre est servi en HTTPS par Traefik. Créez-la d'abord dans l'onglet Traefik.", to: "/settings?tab=traefik", action: "Ouvrir Traefik" };
  if (!setup.hasApplication) return { tone: "info", title: "Étape 2 sur 5 : créez l'application registry", text: "Choisissez un nom de domaine qui pointe vers l'hôte de Traefik, vérifiez l'aperçu des fichiers, puis créez l'application. Rien n'est déployé tout de suite." };
  if (!setup.deployed) return { tone: "info", title: "Étape 3 sur 5 : déployez l'application registry", text: "Ouvrez l'application, relisez ses fichiers générés, puis déployez-la. Les mots de passe sont générés et enregistrés pour vous : vous n'avez rien à saisir." };
  if (!probe) return { tone: "info", title: "Étape 4 sur 5 : testez l'accès", text: "« Tester l'accès » vérifie le nom de domaine, le certificat, l'authentification et, comptes séparés, que le compte de lecture ne peut pas écrire." };
  if (!probe.dns.ok) return { tone: "warning", title: "Le nom de domaine ne se résout pas", text: "Créez un enregistrement DNS (type A ou CNAME) qui pointe le nom du registre vers l'hôte de Traefik, attendez sa propagation, puis relancez le test." };
  if (!probe.tls.ok) return { tone: "warning", title: "Certificat refusé ou port 443 injoignable", text: "Les démons Docker refuseraient aussi ce certificat. Si Traefik utilise l'autorité de test de Let's Encrypt, passez-le en production (onglet Traefik) ; vérifiez aussi que les ports 80 et 443 de l'hôte sont ouverts." };
  if (!probe.anonymous.ok) return { tone: "warning", title: "Le registre ne répond pas comme attendu", text: "L'accès sans identifiants devrait être refusé (401). Vérifiez que l'application registry est bien déployée et que le nom de domaine n'est pas servi par une autre application." };
  if (!probe.authenticated.ok) return { tone: "warning", title: "Identifiants refusés", text: "Si vous venez de renouveler les mots de passe, redéployez l'application registry pour les appliquer, puis relancez le test." };
  if (probe.pullWriteDenied && !probe.pullWriteDenied.ok) return { tone: "warning", title: "Le compte de lecture peut écrire", text: "Le routeur d'écriture de Traefik n'est pas actif : redéployez l'application registry (et vérifiez que le registre n'est pas joint en contournant Traefik)." };
  if (!setup.separated && setup.managed) return { tone: "info", title: "Étape 5 sur 5 : séparez les comptes", text: "Un seul compte fait tout et il est transmis aux hôtes. « Séparer les comptes » crée un compte de lecture seule, seul transmis aux déploiements ; redéployez ensuite l'application." };
  return { tone: "success", title: "Registre prêt", text: "Vous pouvez lancer un correctif depuis la page Images (« Corriger »). Pensez à la règle de rétention ci-dessous pour garder le registre propre.", to: "/images", action: "Ouvrir la page Images" };
}
