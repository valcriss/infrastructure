import { ChangeCredentialsSchema, LoginRequestSchema, SetupRequestSchema } from "@infra/shared";
import { z } from "zod";
import { ComposeBody, CreateBody, DeployBody, FileBody, ServiceEnvBody, VariablesBody } from "./stack-routes.js";
import { BackupConfigBody, BackupTestBody, RestoreApplyBody, RestorePreviewBody } from "./backup-routes.js";
import { CreateTokenBody } from "./token-routes.js";

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
  { method: "put", path: "/api/v1/stacks/{id}/compose", summary: "Remplacer le Compose", tag: "Stacks", access: "any", body: ComposeBody, success: { status: 200, description: "Nouvelle révision (ou inchangée)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409] },
  { method: "patch", path: "/api/v1/stacks/{id}/variables", summary: "Modifier les variables de stack", tag: "Stacks", access: "any", body: VariablesBody, success: { status: 200, description: "Nouvelle révision (ou inchangée)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409] },
  { method: "patch", path: "/api/v1/stacks/{id}/services/{service}/environment", summary: "Modifier les variables d'environnement d'un service", tag: "Stacks", access: "any", body: ServiceEnvBody, success: { status: 200, description: "Nouvelle révision (YAML préservé)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409, 422], description: "Conserve commentaires, ordre et expressions `${…}`. Refuse les alias YAML et les clés de fusion `<<`." },
  { method: "put", path: "/api/v1/stacks/{id}/files/{path}", summary: "Enregistrer un fichier associé", tag: "Stacks", access: "any", body: FileBody, success: { status: 200, description: "Nouvelle révision (ou inchangée)", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409], description: "`path` est un chemin relatif pouvant contenir des `/`." },
  { method: "delete", path: "/api/v1/stacks/{id}/files/{path}", summary: "Supprimer un fichier associé", tag: "Stacks", access: "any", query: [{ name: "expectedRevision", required: true, schema: { type: "integer", minimum: 1 } }], success: { status: 200, description: "Nouvelle révision", ref: "ChangeResult" }, errors: [400, 401, 403, 404, 409] },
  { method: "get", path: "/api/v1/stacks/{id}/revisions", summary: "Historique des révisions", tag: "Stacks", access: "any", success: { status: 200, description: "Révisions, de la plus récente à la plus ancienne" }, errors: [401, 404] },
  { method: "get", path: "/api/v1/stacks/{id}/revisions/{revision}", summary: "Contenu d'une révision", tag: "Stacks", access: "any", success: { status: 200, description: "Compose, variables (masquées) et fichiers de la révision" }, errors: [401, 404] },
  { method: "get", path: "/api/v1/stacks/{id}/logs", summary: "Logs en direct (Server-Sent Events)", tag: "Stacks", access: "any", query: [{ name: "service", schema: { type: "string" }, description: "Service Compose ; tous si absent" }, { name: "tail", schema: { type: "integer", minimum: 0, maximum: 1000, default: 100 } }], success: { status: 200, description: "Flux `text/event-stream` : événements `lines` (tableau de lignes) et `end` (raison)", contentType: "text/event-stream" }, errors: [401, 404, 409, 429], description: "Flux borné (nombre, durée, débit). Les valeurs sont celles des conteneurs, non masquées." },

  { method: "post", path: "/api/v1/stacks/{id}/deploy", summary: "Déployer ou redéployer une révision", tag: "Opérations", access: "any", body: DeployBody, success: { status: 202, description: "Opération acceptée", ref: "OperationAccepted" }, errors: [401, 403, 404, 409, 422], description: "Applique exactement la révision demandée (courante par défaut). En-tête `Idempotency-Key` accepté : un rejeu renvoie 200 avec la même opération." },
  { method: "post", path: "/api/v1/stacks/{id}/stop", summary: "Arrêter la stack", tag: "Opérations", access: "any", success: { status: 202, description: "Opération acceptée", ref: "OperationAccepted" }, errors: [401, 403, 404, 409, 422], description: "Stoppe les conteneurs ; configuration, fichiers et volumes sont conservés." },
  { method: "post", path: "/api/v1/stacks/{id}/start", summary: "Démarrer la stack", tag: "Opérations", access: "any", success: { status: 202, description: "Opération acceptée", ref: "OperationAccepted" }, errors: [401, 403, 404, 409, 422], description: "Relance la dernière configuration déployée, jamais un brouillon." },
  { method: "get", path: "/api/v1/dashboard", summary: "Tableau de bord de supervision", tag: "Supervision", access: "any", query: [{ name: "hostId", schema: uuid, description: "Limiter à un hôte" }, { name: "stackId", schema: uuid, description: "Limiter à une stack" }], success: { status: 200, description: "Agents, stacks (état, raison, dernière observation), conteneurs, utilisation et alertes" }, errors: [400, 401], description: "Un hôte hors ligne ou une observation périmée donnent l'état « unknown » — jamais « stopped » — et la dernière observation est conservée. Alertes calculées à la lecture : agent hors ligne, observation périmée, stack dégradée ou arrêtée, healthcheck en échec, redémarrages répétés, sauvegarde Git en échec, opération au résultat inconnu." },
  { method: "get", path: "/api/v1/stacks/{id}/metrics", summary: "Métriques d'une stack (CPU, mémoire, réseau)", tag: "Supervision", access: "any", query: [{ name: "range", schema: { type: "string", enum: ["1h", "6h", "24h", "7d"], default: "1h" } }, { name: "service", schema: { type: "string" }, description: "Limiter à un service Compose" }], success: { status: 200, description: "Séries par conteneur (≤ 240 points), débits réseau déduits des compteurs cumulés" }, errors: [400, 401, 404], description: "Collecte toutes les 30 s (METRICS_INTERVAL_SEC), conservée 7 jours (METRICS_RETENTION_DAYS) par défaut. CPU : 100 = un cœur." },
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
