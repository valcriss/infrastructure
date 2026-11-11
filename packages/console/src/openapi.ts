import { ChangeCredentialsSchema, LoginRequestSchema, SetupRequestSchema } from "@infra/shared";
import { z } from "zod";
import { ComposeBody, CreateBody, DeployBody, FileBody, HealthcheckBody, ServiceEnvBody, VariablesBody } from "./stack-routes.js";
import { BackupConfigBody, BackupTestBody, RestoreApplyBody, RestorePreviewBody } from "./backup-routes.js";
import { BatchScanBody, ManualScanBody, PolicyBody, RegistryBody, SecuritySettingsBody } from "./image-routes.js";
import { PreviewBody, PruneBody } from "./host-disk-routes.js";
import { CreateTokenBody } from "./token-routes.js";
import { IMAGE_ROUTE_DOCS, REGISTRY_APP_ROUTE_DOCS, REMOVAL_ROUTE_DOCS, SECURITY_ROUTE_DOCS, TERMINAL_ROUTE_DOCS, TRAEFIK_ROUTE_DOCS, USER_ROUTE_DOCS } from "./openapi-users.js";

/** Qui peut appeler la route. */
type Access = "public" | "session" | "any";

interface QueryParam {
  name: string;
  schema: Record<string, unknown>;
  required?: boolean;
  description?: string;
}

export interface RouteDoc {
  method: "get" | "post" | "put" | "patch" | "delete";
  /** Chemin OpenAPI, paramètres entre accolades. */
  path: string;
  summary: string;
  tag: string;
  access: Access;
  /** Schéma Zod du corps de requête, source unique avec la validation réelle. */
  body?: z.ZodType;
  query?: QueryParam[];
  success: { status: number; description: string; ref?: string; contentType?: string };
  errors?: number[];
  description?: string;
}

const uuid = { type: "string", format: "uuid" };

/**
 * Description de l'API. Les corps de requête sont générés à partir des
 * schémas Zod réellement utilisés par les routes ; un test vérifie que cette
 * liste couvre exactement les routes enregistrées.
 */
export const ROUTE_DOCS: RouteDoc[] = [
  ...USER_ROUTE_DOCS,
  ...TERMINAL_ROUTE_DOCS,
  ...TRAEFIK_ROUTE_DOCS,
  ...REGISTRY_APP_ROUTE_DOCS,
  ...IMAGE_ROUTE_DOCS,
  ...SECURITY_ROUTE_DOCS,
  ...REMOVAL_ROUTE_DOCS,
  { method: "get", path: "/status", summary: "État public minimal", tag: "Système", access: "public", success: { status: 200, description: "Processus en vie et console initialisée ou non" } },
  { method: "get", path: "/api/v1/openapi.json", summary: "Contrat OpenAPI", tag: "Système", access: "public", success: { status: 200, description: "Ce document" } },

  { method: "post", path: "/api/v1/setup", summary: "Initialiser la console (création de l'administrateur)", tag: "Compte", access: "public", body: SetupRequestSchema, success: { status: 201, description: "Compte créé et session ouverte" }, errors: [400, 403, 404, 409], description: "Disponible une seule fois, avec le secret d'initialisation affiché dans les logs de la console. Étape 1 de l'assistant : ensuite, configurer le dépôt Git (ou restaurer) puis générer la clé de restauration." },
  { method: "post", path: "/api/v1/session", summary: "Ouvrir une session", tag: "Compte", access: "public", body: LoginRequestSchema, success: { status: 200, description: "Session ouverte (cookie HttpOnly)" }, errors: [400, 401, 429] },
  { method: "get", path: "/api/v1/session", summary: "Session courante", tag: "Compte", access: "session", success: { status: 200, description: "Identifiant de l'administrateur" }, errors: [401] },
  { method: "delete", path: "/api/v1/session", summary: "Fermer la session", tag: "Compte", access: "public", success: { status: 204, description: "Session fermée" } },
  { method: "get", path: "/api/v1/admin/restoration-key", summary: "Clé publique de restauration", tag: "Compte", access: "session", success: { status: 200, description: "Destinataire age (clé publique)" }, errors: [401] },
  { method: "post", path: "/api/v1/admin/restoration-key", summary: "Générer la clé de restauration", tag: "Compte", access: "session", success: { status: 201, description: "Clé privée (affichée une seule fois) et clé publique" }, errors: [401, 409], description: "Une seule fois : la clé privée n'est jamais stockée. Elle chiffre les secrets de la sauvegarde Git ; sans elle ils sont irrécupérables. Pas de rotation dans cette version." },
  { method: "put", path: "/api/v1/admin/credentials", summary: "Modifier les identifiants administrateur", tag: "Compte", access: "session", body: ChangeCredentialsSchema, success: { status: 200, description: "Identifiants mis à jour ; les autres sessions sont révoquées" }, errors: [400, 401, 403, 429] },

  { method: "post", path: "/api/v1/api-tokens", summary: "Créer un jeton API", tag: "Jetons API", access: "session", body: CreateTokenBody, success: { status: 201, description: "Jeton créé ; sa valeur n'est affichée qu'une fois" }, errors: [400, 401, 409], description: "Réservé à la session : un jeton API ne peut pas en créer d'autres." },
  { method: "get", path: "/api/v1/api-tokens", summary: "Lister les jetons API", tag: "Jetons API", access: "session", success: { status: 200, description: "Jetons (sans leur valeur)" }, errors: [401] },
  { method: "delete", path: "/api/v1/api-tokens/{id}", summary: "Révoquer un jeton API", tag: "Jetons API", access: "session", success: { status: 204, description: "Jeton révoqué" }, errors: [401, 404] },

  { method: "get", path: "/api/v1/hosts", summary: "Lister les hôtes", tag: "Hôtes", access: "any", success: { status: 200, description: "Hôtes, présence et dernière observation" }, errors: [401] },
  { method: "get", path: "/api/v1/hosts/{id}", summary: "Détail d'un hôte et de ses conteneurs", tag: "Hôtes", access: "any", success: { status: 200, description: "Hôte et inventaire de la dernière observation" }, errors: [401, 404] },
  { method: "delete", path: "/api/v1/hosts/{id}", summary: "Révoquer un hôte", tag: "Hôtes", access: "any", success: { status: 204, description: "Hôte révoqué ; son agent est déconnecté" }, errors: [401, 403, 404] },
  { method: "get", path: "/api/v1/hosts/{id}/projects", summary: "Projets Compose observés sur un hôte", tag: "Hôtes", access: "any", success: { status: 200, description: "Projets gérés par une stack ou importables" }, errors: [401, 404] },
  { method: "post", path: "/api/v1/agents/enrollment-tokens", summary: "Préparer l'enrôlement d'un agent", tag: "Hôtes", access: "any", body: z.object({ hostName: z.string().min(1).max(128).optional() }), success: { status: 201, description: "Jeton à usage unique, valable une heure" }, errors: [400, 401, 403] },

  { method: "get", path: "/api/v1/stacks", summary: "Lister les stacks", tag: "Stacks", access: "any", success: { status: 200, description: "Stacks, révisions et état observé" }, errors: [401] },
  { method: "post", path: "/api/v1/stacks", summary: "Créer une stack (révision 1)", tag: "Stacks", access: "any", body: CreateBody, success: { status: 201, description: "Stack créée, rien n'est déployé", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409], description: "Le Compose doit référencer des images préconstruites : `build` et `include` sont rejetés. `adopt: true` importe un projet Compose déjà présent sur l'hôte." },
  { method: "get", path: "/api/v1/stacks/{id}", summary: "Détail d'une stack (révision courante)", tag: "Stacks", access: "any", success: { status: 200, description: "Stack, Compose, variables (valeurs sensibles masquées), fichiers et conteneurs observés" }, errors: [401, 404] },
  { method: "put", path: "/api/v1/stacks/{id}/compose", summary: "Remplacer le Compose", tag: "Stacks", access: "any", body: ComposeBody, success: { status: 200, description: "Nouvelle révision (ou inchangée)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409, 423] },
  { method: "patch", path: "/api/v1/stacks/{id}/variables", summary: "Modifier les variables de stack", tag: "Stacks", access: "any", body: VariablesBody, success: { status: 200, description: "Nouvelle révision (ou inchangée)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409, 423] },
  { method: "patch", path: "/api/v1/stacks/{id}/services/{service}/environment", summary: "Modifier les variables d'environnement d'un service", tag: "Stacks", access: "any", body: ServiceEnvBody, success: { status: 200, description: "Nouvelle révision (YAML préservé)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409, 422, 423], description: "Conserve commentaires, ordre et expressions `${…}`. Refuse les alias YAML et les clés de fusion `<<`." },
  { method: "post", path: "/api/v1/stacks/{id}/services/{service}/healthcheck/preview", summary: "Aperçu de l'ajout d'un healthcheck à un service", tag: "Stacks", access: "any", body: HealthcheckBody, success: { status: 200, description: "Compose avant et après modification (rien n'est enregistré)" }, errors: [400, 401, 403, 404, 409, 422] },
  { method: "patch", path: "/api/v1/stacks/{id}/services/{service}/healthcheck", summary: "Définir le healthcheck d'un service", tag: "Stacks", access: "any", body: HealthcheckBody, success: { status: 200, description: "Nouvelle révision (YAML préservé)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409, 422, 423], description: "Écrit un bloc `healthcheck` (`CMD-SHELL`). Refuse les alias YAML et les clés de fusion `<<`. La révision n'est pas déployée." },
  { method: "put", path: "/api/v1/stacks/{id}/files/{path}", summary: "Enregistrer un fichier associé", tag: "Stacks", access: "any", body: FileBody, success: { status: 200, description: "Nouvelle révision (ou inchangée)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409, 423], description: "`path` est un chemin relatif pouvant contenir des `/`." },
  { method: "delete", path: "/api/v1/stacks/{id}/files/{path}", summary: "Supprimer un fichier associé", tag: "Stacks", access: "any", query: [{ name: "expectedRevision", required: true, schema: { type: "integer", minimum: 1 } }], success: { status: 200, description: "Nouvelle révision", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409, 423] },
  { method: "get", path: "/api/v1/stacks/{id}/revisions", summary: "Historique des révisions", tag: "Stacks", access: "any", success: { status: 200, description: "Révisions, de la plus récente à la plus ancienne" }, errors: [401, 404] },
  { method: "get", path: "/api/v1/stacks/{id}/revisions/{revision}", summary: "Contenu d'une révision", tag: "Stacks", access: "any", success: { status: 200, description: "Compose, variables (masquées) et fichiers de la révision" }, errors: [401, 404] },
  { method: "get", path: "/api/v1/stacks/{id}/logs", summary: "Logs en direct (Server-Sent Events)", tag: "Stacks", access: "any", query: [{ name: "service", schema: { type: "string" }, description: "Service Compose ; tous si absent" }, { name: "tail", schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 } }], success: { status: 200, description: "Flux `text/event-stream` : événements `lines` (tableau de lignes) et `end` (raison)", contentType: "text/event-stream" }, errors: [401, 404, 409, 429], description: "Flux borné (nombre, durée, débit). Les valeurs sont celles des conteneurs, non masquées." },

  { method: "post", path: "/api/v1/stacks/{id}/deploy", summary: "Déployer ou redéployer une révision", tag: "Opérations", access: "any", body: DeployBody, success: { status: 202, description: "Opération acceptée", ref: "OperationAccepted" }, errors: [401, 403, 404, 409, 422], description: "Applique exactement la révision demandée (courante par défaut). En-tête `Idempotency-Key` accepté : un rejeu renvoie 200 avec la même opération." },
  { method: "post", path: "/api/v1/stacks/{id}/stop", summary: "Arrêter la stack", tag: "Opérations", access: "any", success: { status: 202, description: "Opération acceptée", ref: "OperationAccepted" }, errors: [401, 403, 404, 409, 422], description: "Stoppe les conteneurs ; configuration, fichiers et volumes sont conservés." },
  { method: "post", path: "/api/v1/stacks/{id}/start", summary: "Démarrer la stack", tag: "Opérations", access: "any", success: { status: 202, description: "Opération acceptée", ref: "OperationAccepted" }, errors: [401, 403, 404, 409, 422], description: "Relance la dernière configuration déployée, jamais un brouillon." },
  { method: "get", path: "/api/v1/dashboard", summary: "Tableau de bord de supervision", tag: "Supervision", access: "any", query: [{ name: "hostId", schema: uuid, description: "Limiter à un hôte" }, { name: "stackId", schema: uuid, description: "Limiter à une stack" }], success: { status: 200, description: "Agents, stacks (état, raison, dernière observation), conteneurs, utilisation et alertes" }, errors: [400, 401], description: "Un hôte hors ligne ou une observation périmée donnent l'état « unknown » — jamais « stopped » — et la dernière observation est conservée. Alertes calculées à la lecture : agent hors ligne, observation périmée, stack dégradée ou arrêtée, healthcheck en échec, redémarrages répétés, sauvegarde Git en échec, opération au résultat inconnu." },
  { method: "get", path: "/api/v1/hosts/{id}/projects/{name}", summary: "Fiche d'un projet Compose (lecture seule)", tag: "Supervision", access: "any", success: { status: 200, description: "Application (état, images, utilisation) et conteneurs avec ports, réseaux, montages et libellés Compose" }, errors: [400, 401, 404], description: "Fonctionne pour un projet géré comme pour un projet observé (non géré). Ne renvoie jamais les variables d'environnement des conteneurs." },
  { method: "get", path: "/api/v1/hosts/{id}/projects/{name}/storage", summary: "Stockage d'un projet Compose : montages et tailles sur le disque", tag: "Supervision", access: "any", success: { status: 200, description: "Volumes nommés et dossiers « bind » distincts avec taille, services utilisateurs, total et date de mesure ; `measuring` indique une mesure en cours" }, errors: [400, 401, 404], description: "Les tailles sont mesurées par l'agent (relevé périodique, toutes les 6 h environ, ou à la demande) : `sizeBytes` vaut `null` tant qu'un montage n'a pas été mesuré, ou si son emplacement n'est pas mesurable (`note`). Un volume partagé par plusieurs services n'apparaît qu'une fois et n'est compté qu'une fois dans le total." },
  { method: "post", path: "/api/v1/hosts/{id}/projects/{name}/storage/measure", summary: "Mesurer les montages d'un projet Compose", tag: "Supervision", access: "any", success: { status: 202, description: "Mesure demandée à l'agent ; relire GET …/storage jusqu'à `measuring: false`" }, errors: [400, 401, 403, 404, 409], description: "Une seule mesure à la fois par hôte. La mesure d'un gros dossier peut durer plusieurs minutes ; elle n'écrit rien sur l'hôte (conteneur éphémère, montage en lecture seule)." },
  { method: "get", path: "/api/v1/containers", summary: "Conteneurs de tous les hôtes", tag: "Supervision", access: "any", success: { status: 200, description: "Un conteneur par entrée : état, healthcheck, image, ports, utilisation, application rattachée" }, errors: [401], description: "Inclut les conteneurs lancés hors Compose (sans application). « protected » : conteneur de la console ou de son agent (aucune action ni terminal)." },
  { method: "get", path: "/api/v1/hosts/{hostId}/containers/{containerId}/logs", summary: "Logs en direct d'un conteneur (Server-Sent Events)", tag: "Supervision", access: "any", query: [{ name: "tail", schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 } }], success: { status: 200, description: "Flux `text/event-stream` : événements `lines` et `end`" }, errors: [400, 401, 404, 409, 429], description: "Mêmes limites que les logs d'une stack (flux par hôte, durée maximale)." },
  { method: "get", path: "/api/v1/hosts/{hostId}/containers/{containerId}/metrics", summary: "Métriques d'un conteneur", tag: "Supervision", access: "any", query: [{ name: "range", schema: { type: "string", enum: ["1h", "6h", "24h", "7d"], default: "1h" } }], success: { status: 200, description: "Série du conteneur (≤ 240 points)" }, errors: [400, 401, 404] },
  { method: "post", path: "/api/v1/hosts/{hostId}/containers/{containerId}/actions/{action}", summary: "Démarrer, arrêter ou redémarrer un conteneur", tag: "Stacks", access: "any", success: { status: 202, description: "Action exécutée par l'agent" }, errors: [400, 401, 403, 404, 409, 422, 504], description: "`action` : start, stop ou restart. Réservé aux opérateurs. Hors cycle Compose : un redéploiement de l'application remet le conteneur dans l'état défini. Refusé pour les conteneurs de la console et de l'agent." },
  { method: "get", path: "/api/v1/hosts/{id}/projects/{name}/versions", summary: "Historique des versions d'un projet Compose observé", tag: "Supervision", access: "any", success: { status: 200, description: "Changements d'image ou de contenu par service, du plus récent au plus ancien (500 au plus)" }, errors: [400, 401, 404], description: "Une entrée est ajoutée à chaque changement de l'image (étiquette ou contenu) d'un service d'un projet non géré ; l'historique est conservé après la prise en charge. 100 versions par service au plus." },
  { method: "get", path: "/api/v1/hosts/{id}/projects/{name}/metrics", summary: "Métriques d'un projet Compose", tag: "Supervision", access: "any", query: [{ name: "range", schema: { type: "string", enum: ["1h", "6h", "24h", "7d"], default: "1h" } }, { name: "service", schema: { type: "string" }, description: "Limiter à un service Compose" }], success: { status: 200, description: "Séries par conteneur (≤ 240 points)" }, errors: [400, 401, 404] },
  { method: "get", path: "/api/v1/hosts/{id}/projects/{name}/logs", summary: "Logs en direct d'un conteneur d'un projet (Server-Sent Events)", tag: "Supervision", access: "any", query: [{ name: "container", schema: { type: "string" }, description: "Identifiant du conteneur (12 à 64 caractères hexadécimaux), obligatoire" }, { name: "tail", schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 } }], success: { status: 200, description: "Flux `text/event-stream` : événements `lines` et `end`" }, errors: [400, 401, 404, 409, 429], description: "Mêmes limites que les logs d'une stack (5 flux par hôte, 1 h par flux)." },
  { method: "get", path: "/api/v1/hosts/{id}/disk-usage", summary: "Espace disque Docker d'un hôte (docker system df)", tag: "Hôtes", access: "any", success: { status: 200, description: "Totaux et part récupérable des images, conteneurs, volumes et cache de build, avec la date du relevé" }, errors: [401, 404], description: "Le relevé est effectué par l'agent toutes les 10 minutes (et à la demande). Les images sont comptées avec leurs couches partagées, d'après Docker." },
  { method: "post", path: "/api/v1/hosts/{id}/disk-usage/refresh", summary: "Actualiser le relevé de l'espace disque", tag: "Hôtes", access: "session", success: { status: 200, description: "Nouveau relevé" }, errors: [401, 404, 409, 504], description: "Demande un relevé à l'agent et attend sa réponse (30 s au plus)." },
  { method: "post", path: "/api/v1/hosts/{id}/prune/preview", summary: "Aperçu d'un nettoyage (rien n'est supprimé)", tag: "Hôtes", access: "session", body: PreviewBody, success: { status: 200, description: "Éléments exacts qui seraient supprimés, espace estimé, avertissements" }, errors: [400, 401, 404, 409], description: "Calculé sur le dernier relevé (5 minutes au plus). Docker n'ayant pas de mode simulation, la liste vient du relevé de l'agent." },
  { method: "post", path: "/api/v1/hosts/{id}/prune", summary: "Nettoyer un hôte (conteneurs arrêtés, images, réseaux, volumes, cache de build)", tag: "Hôtes", access: "session", body: PruneBody, success: { status: 202, description: "Nettoyage lancé ; suivre son résultat avec GET /api/v1/prune-runs/{runId}" }, errors: [400, 401, 404, 409], description: "Réservé à la session de l'administrateur (jamais un jeton API). La sélection est recalculée par la console ; l'agent ne supprime que ce qui est encore inutilisé et non protégé, sans jamais forcer. Supprimer des volumes exige confirmHostName (nom de l'hôte)." },
  { method: "get", path: "/api/v1/hosts/{id}/prune-runs", summary: "Historique des nettoyages d'un hôte", tag: "Hôtes", access: "any", success: { status: 200, description: "20 derniers nettoyages" }, errors: [401, 404] },
  { method: "get", path: "/api/v1/prune-runs/{runId}", summary: "Résultat d'un nettoyage", tag: "Hôtes", access: "any", success: { status: 200, description: "État, éléments supprimés, espace libéré (estimation), éléments ignorés et erreurs" }, errors: [401, 404] },
  { method: "post", path: "/api/v1/images/scans", summary: "Scanner plusieurs images à la suite", tag: "Sécurité des images", access: "any", body: BatchScanBody, success: { status: 202, description: "Nombre d'images mises en file, déjà en file ou ignorées (hôte hors ligne) ; avec dryRun, simple décompte (200)" }, errors: [400, 401], description: "Périmètre : scope never (aucun scan réussi), outdated (jamais scannées ou périmées) ou all ; managedOnly limite aux applications gérées. Tous les hôtes partagent une seule file : un scan à la fois, dans l'ordre. Un scan en attente a l'état pending (rang dans la file : scan.queuePosition de GET /api/v1/images)." },
  { method: "delete", path: "/api/v1/images/scans/queue", summary: "Annuler les scans en attente", tag: "Sécurité des images", access: "any", query: [{ name: "only", schema: { type: "string", enum: ["pending", "running", "all"], default: "pending" }, description: "pending : retire les scans en attente ; running : déclare perdu le scan en cours et laisse la file reprendre (déblocage manuel) ; all : les deux" }], success: { status: 200, description: "Nombre de scans retirés de la file (removed) et de scans en cours interrompus (interrupted)" }, errors: [401], description: "Seuls les scans qui n'ont pas commencé sont retirés ; celui en cours va à son terme." },
  { method: "get", path: "/api/v1/applications", summary: "Applications (gérées et observées)", tag: "Supervision", access: "any", success: { status: 200, description: "Une entrée par projet Compose : état, conteneurs, utilisation, images avec compteurs de vulnérabilités, mises à jour" }, errors: [401], description: "« managed » : stack pilotée par la console. « observed » : projet Compose qui tourne sur un hôte sans que la console en ait le Compose (importable). Un conteneur terminé avec le code 0 n'est pas compté comme en échec." },
  { method: "get", path: "/api/v1/dashboard/cve-history", summary: "Évolution du nombre de CVE par gravité", tag: "Supervision", access: "any", query: [{ name: "days", schema: { type: "integer", enum: [7, 30, 90], default: 30 } }, { name: "mode", schema: { type: "string", enum: ["filtered", "all"], default: "filtered" }, description: "filtered : seuil de gravité des paramètres ; all : toutes les gravités" }, { name: "hostId", schema: { type: "string", format: "uuid" } }, { name: "stackId", schema: { type: "string", format: "uuid" } }, { name: "project", schema: { type: "string" }, description: "Projet Compose (géré ou observé) ; exige hostId" }, { name: "service", schema: { type: "string" }, description: "Service Compose, avec stackId ou project" }], success: { status: 200, description: "Un point toutes les 6 h (7 jours) ou par jour : critiques, élevées, moyennes, faibles, inconnues ; firstScanAt = début de l'historique" }, errors: [400, 401], description: "Reconstruit depuis les scans réussis conservés, pour les images actuellement utilisées. Les risques acceptés ne sont pas retranchés de l'historique." },
  { method: "get", path: "/api/v1/dashboard/overview", summary: "Utilisation globale (CPU, mémoire, réseau, hôtes)", tag: "Supervision", access: "any", query: [{ name: "range", schema: { type: "string", enum: ["1h", "6h", "24h", "7d"], default: "1h" } }], success: { status: 200, description: "Totaux des conteneurs, 5 applications les plus gourmandes, utilisation de chaque hôte (≤ 240 points par série)" }, errors: [400, 401], description: "CPU des conteneurs : 100 = un cœur. Utilisation de l'hôte : CPU global (0–100), mémoire (hors cache récupérable) et disque de la partition de l'espace de travail ; absente tant que l'agent n'a pas envoyé de relevé." },
  { method: "get", path: "/api/v1/stacks/{id}/metrics", summary: "Métriques d'une stack (CPU, mémoire, réseau)", tag: "Supervision", access: "any", query: [{ name: "range", schema: { type: "string", enum: ["1h", "6h", "24h", "7d"], default: "1h" } }, { name: "service", schema: { type: "string" }, description: "Limiter à un service Compose" }], success: { status: 200, description: "Séries par conteneur (≤ 240 points), débits réseau déduits des compteurs cumulés" }, errors: [400, 401, 404], description: "Collecte toutes les 30 s (METRICS_INTERVAL_SEC), conservée 7 jours (METRICS_RETENTION_DAYS) par défaut. CPU : 100 = un cœur." },
  { method: "get", path: "/api/v1/images", summary: "Images utilisées et état de leurs scans", tag: "Sécurité des images", access: "any", query: [{ name: "hostId", schema: uuid }, { name: "stackId", schema: uuid }], success: { status: 200, description: "Images regroupées par contenu (identifiant + plateforme), avec leurs utilisateurs (stacks, services, conteneurs) et l'état du scan" }, errors: [400, 401], description: "L'état d'un scan distingue `never` (jamais scanné), `failed` (scan en échec), `clean` (aucune vulnérabilité connue) et `vulnerable`. Le dernier résultat réussi reste disponible, daté, même si la dernière tentative a échoué." },
  { method: "get", path: "/api/v1/images/{imageId}/scan", summary: "Vulnérabilités du dernier scan réussi d'une image", tag: "Sécurité des images", access: "any", query: [{ name: "platform", schema: { type: "string" } }, { name: "severity", schema: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] } }, { name: "q", schema: { type: "string" }, description: "Filtre sur l'identifiant de vulnérabilité ou le paquet" }, { name: "limit", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }, { name: "offset", schema: { type: "integer", minimum: 0, default: 0 } }], success: { status: 200, description: "Résumé du scan (date, version de Trivy, fraîcheur de la base) et vulnérabilités (identifiant, paquet, version installée et corrigée, lien)" }, errors: [400, 401, 404], description: "La liste détaillée est bornée à 2000 entrées par scan (`truncated`) ; les compteurs restent exacts." },
  { method: "post", path: "/api/v1/images/{imageId}/scans", summary: "Scanner une image avec Trivy", tag: "Sécurité des images", access: "any", body: ManualScanBody, success: { status: 202, description: "Scan accepté (ou scan déjà actif pour ce contenu)" }, errors: [400, 401, 403, 404, 409], description: "Un seul scan actif par contenu d'image, un seul à la fois par hôte. L'image est exportée puis lue par un conteneur Trivy éphémère sans accès au socket Docker. Ne bloque aucun déploiement." },
  { method: "get", path: "/api/v1/scans/{id}", summary: "Suivre un scan", tag: "Sécurité des images", access: "any", success: { status: 200, description: "État du scan" }, errors: [401, 404] },
  { method: "post", path: "/api/v1/stacks/{id}/scans", summary: "Scanner les images d'une stack", tag: "Sécurité des images", access: "any", success: { status: 202, description: "Scans demandés image par image" }, errors: [401, 403, 404, 409] },
  { method: "get", path: "/api/v1/stacks/{id}/images", summary: "Images, scans et versions disponibles par composant", tag: "Sécurité des images", access: "any", success: { status: 200, description: "Pour chaque service : image, scan, règle de suivi et dernière vérification des versions" }, errors: [401, 404], description: "En cas d'échec du registre, la dernière observation réussie est conservée avec sa date (`lastSuccessAt`)." },
  { method: "post", path: "/api/v1/stacks/{id}/image-checks", summary: "Vérifier les nouvelles versions des images", tag: "Sécurité des images", access: "any", success: { status: 202, description: "Vérification lancée ; lire le résultat avec GET /stacks/{id}/images" }, errors: [401, 403, 404], description: "Compare le digest déployé au registre (même tag, contenu différent, pour la plateforme cible) et cherche de nouveaux tags selon la règle du composant. Ne télécharge aucune image et ne déploie rien." },
  { method: "put", path: "/api/v1/stacks/{id}/services/{service}/update-policy", summary: "Règle de suivi des versions d'un composant", tag: "Sécurité des images", access: "any", body: PolicyBody, success: { status: 200, description: "Règle enregistrée (sauvegardée dans Git avec la stack)" }, errors: [400, 401, 403, 404], description: "`same_tag` (contenu du même tag), `patch`, `minor`, `major` ou `pattern` (expression régulière sans groupe répété). Les préversions sont exclues." },
  { method: "get", path: "/api/v1/settings/security", summary: "Réglages de sécurité des images (périodes, seuil de gravité)", tag: "Sécurité des images", access: "any", success: { status: 200, description: "Heures entre deux passages planifiés (0 = désactivé), gravité minimale signalée (minSeverity) et prise en compte des vulnérabilités « inconnues » (includeUnknown)" }, errors: [401] },
  { method: "put", path: "/api/v1/settings/security", summary: "Modifier les réglages de sécurité des images", tag: "Sécurité des images", access: "session", body: SecuritySettingsBody, success: { status: 200, description: "Paramètres enregistrés" }, errors: [400, 401] },
  { method: "get", path: "/api/v1/registries", summary: "Registres d'images configurés", tag: "Registres", access: "session", success: { status: 200, description: "Registres et identifiants (sans mot de passe)" }, errors: [401] },
  { method: "put", path: "/api/v1/registries/{registry}", summary: "Configurer un registre (public ou privé)", tag: "Registres", access: "session", body: RegistryBody, success: { status: 200, description: "Registre enregistré" }, errors: [400, 401], description: "Le mot de passe ou jeton est chiffré avec la clé maître et n'est jamais renvoyé. Il n'est envoyé qu'au service d'authentification légitime du registre. `insecure` autorise HTTP pour un registre interne." },
  { method: "delete", path: "/api/v1/registries/{registry}", summary: "Supprimer un registre configuré", tag: "Registres", access: "session", success: { status: 204, description: "Registre supprimé" }, errors: [401, 404] },
  { method: "post", path: "/api/v1/registries/{registry}/test", summary: "Tester l'accès à un registre", tag: "Registres", access: "session", success: { status: 200, description: "`ok` et, en cas d'échec, le code et le message" }, errors: [400, 401] },
  { method: "get", path: "/api/v1/backup/status", summary: "Statut de la sauvegarde Git", tag: "Sauvegarde Git", access: "any", success: { status: 200, description: "État, dernier push réussi, révisions en attente, dernière erreur" }, errors: [401], description: "Un push réussi n'est jamais présumé : `pushedRevision` n'avance qu'après un push distant confirmé." },
  { method: "post", path: "/api/v1/backup/sync", summary: "Demander une synchronisation", tag: "Sauvegarde Git", access: "any", query: [{ name: "wait", schema: { type: "boolean", default: false }, description: "Attendre la fin de la synchronisation" }], success: { status: 202, description: "Synchronisation demandée ; statut courant" }, errors: [401, 403], description: "Lève un blocage ou un délai d'attente. Jamais de force push." },
  { method: "put", path: "/api/v1/backup/config", summary: "Configurer le dépôt de sauvegarde", tag: "Sauvegarde Git", access: "session", body: BackupConfigBody, success: { status: 200, description: "Dépôt enregistré (le jeton n'est jamais renvoyé)" }, errors: [400, 401], description: "HTTPS + identifiant + jeton uniquement. Le jeton est chiffré avec la clé maître de la console et ne figure ni dans Git ni dans les journaux." },
  { method: "delete", path: "/api/v1/backup/config", summary: "Désactiver la sauvegarde Git", tag: "Sauvegarde Git", access: "session", success: { status: 204, description: "Configuration et jeton supprimés" }, errors: [401] },
  { method: "post", path: "/api/v1/backup/test", summary: "Tester la connexion au dépôt", tag: "Sauvegarde Git", access: "session", body: BackupTestBody, success: { status: 200, description: "Dépôt vide, branche à créer, sauvegarde existante ou contenu étranger" }, errors: [400, 401, 422, 502] },
  { method: "post", path: "/api/v1/backup/restore/preview", summary: "Analyser une restauration (aucune modification)", tag: "Sauvegarde Git", access: "session", body: RestorePreviewBody, success: { status: 200, description: "Contenu de la sauvegarde, conflits et hôtes à associer" }, errors: [400, 401, 409, 422, 502], description: "Récupère le dépôt dans un espace temporaire, vérifie format, chemins et intégrité, et déchiffre les secrets avec la clé fournie. L'aperçu expire après 10 minutes." },
  { method: "post", path: "/api/v1/backup/restore", summary: "Appliquer une restauration", tag: "Sauvegarde Git", access: "session", body: RestoreApplyBody, success: { status: 200, description: "Stacks créées et remplacées" }, errors: [400, 401, 409, 410], description: "Importe la configuration sans lancer ni arrêter de conteneur. Une stack existante n'est remplacée que sur demande explicite (nouvelle révision). Les agents ne sont pas restaurés : associez chaque hôte de la sauvegarde à un hôte enrôlé." },

  { method: "get", path: "/api/v1/operations", summary: "Lister les opérations", tag: "Opérations", access: "any", query: [{ name: "stackId", schema: uuid }, { name: "limit", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }], success: { status: 200, description: "Opérations récentes" }, errors: [401] },
  { method: "get", path: "/api/v1/operations/{id}", summary: "Suivre une opération", tag: "Opérations", access: "any", success: { status: 200, description: "État, journal expurgé, images déployées (digests) et état observé" }, errors: [401, 404] },
];

const ERROR_TEXT: Record<number, string> = {
  400: "Requête invalide",
  401: "Authentification requise ou invalide",
  403: "Interdit (jeton en lecture seule, origine refusée…)",
  404: "Introuvable",
  409: "Conflit (révision, opération en cours, agent hors ligne…)",
  422: "Requête comprise mais refusée",
  423: "Application générée et entretenue par la console (registry) : modification manuelle refusée",
  429: "Trop de tentatives",
};

/** `{id}` et `{path}` dans une URL OpenAPI → paramètres. */
function pathParams(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const name = m[1] as string;
    const schema =
      name === "id" ? uuid : name === "revision" ? { type: "integer", minimum: 1 } : { type: "string" };
    return { name, in: "path", required: true, schema };
  });
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const d of ROUTE_DOCS) {
    const security =
      d.access === "public" ? [] : d.access === "session" ? [{ cookieAuth: [] }] : [{ bearerAuth: [] }, { cookieAuth: [] }];
    const successContent = d.success.status === 204
      ? undefined
      : {
          [d.success.contentType ?? "application/json"]: {
            schema: d.success.ref ? { $ref: `#/components/schemas/${d.success.ref}` } : { type: d.success.contentType ? "string" : "object" },
          },
        };
    (paths[d.path] ??= {})[d.method] = {
      summary: d.summary,
      ...(d.description ? { description: d.description } : {}),
      tags: [d.tag],
      security,
      parameters: [
        ...pathParams(d.path),
        ...(d.query ?? []).map((q) => ({
          name: q.name,
          in: "query",
          required: q.required ?? false,
          schema: q.schema,
          ...(q.description ? { description: q.description } : {}),
        })),
        ...(d.access !== "public" && ["post"].includes(d.method) && d.path.endsWith("/deploy")
          ? [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 128 } }]
          : []),
      ],
      ...(d.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: z.toJSONSchema(d.body, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) } },
            },
          }
        : {}),
      responses: {
        [String(d.success.status)]: { description: d.success.description, ...(successContent ? { content: successContent } : {}) },
        ...Object.fromEntries(
          (d.errors ?? []).map((s) => [String(s), { description: ERROR_TEXT[s] ?? "Erreur", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }]),
        ),
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Console Docker — API",
      version: "1.0.0",
      description:
        "API d'automatisation de la console : stacks, révisions, variables, fichiers, déploiement, jetons.\n\n" +
        "Sauvegarde : configuration dans un dépôt Git unique (HTTPS + jeton), secrets chiffrés avec age.\n\n" +
        "Authentification : jeton API (`Authorization: Bearer cdt_…`) ou cookie de session. Un jeton `read` ne peut faire que des requêtes GET/HEAD. " +
        "Les routes de compte et de gestion des jetons sont réservées à la session. Toute modification d'une stack exige `expectedRevision` (409 en cas de conflit). " +
        "Les valeurs sensibles ne sont jamais renvoyées.",
    },
    servers: [{ url: "/" }],
    tags: [...new Set(ROUTE_DOCS.map((d) => d.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Jeton API `cdt_…` créé depuis une session." },
        cookieAuth: { type: "apiKey", in: "cookie", name: "sid", description: "Cookie de session HttpOnly." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
            },
          },
        },
        ChangeResult: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid", description: "Présent à la création" },
            revision: { type: "integer", description: "Révision courante après la modification" },
            changed: { type: "boolean", description: "Faux si le contenu était identique : aucune révision créée" },
            backup: {
              type: "object",
              properties: { status: { type: "string", enum: ["not_configured", "pending"] } },
              description: "Statut de la sauvegarde Git : « pending » si un dépôt est configuré (le push est asynchrone, jamais présumé réussi).",
            },
          },
        },
        OperationAccepted: {
          type: "object",
          required: ["operationId", "status", "url"],
          properties: {
            operationId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["pending", "running", "succeeded", "failed", "unknown"] },
            url: { type: "string", description: "URL de suivi : GET /api/v1/operations/{id}" },
          },
        },
      },
    },
  };
}

/** Chemin Fastify (`:id`, `*`) → chemin OpenAPI (`{id}`, `{path}`). */
export function toOpenApiPath(fastifyPath: string): string {
  return fastifyPath.replace(/:(\w+)/g, "{$1}").replace(/\*/g, "{path}");
}
