# Console Docker, sécurité et supervision

Outil auto-hébergé de gestion de stacks Docker. Cadrage complet : [project.md](project.md). Décisions techniques : [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md). Backlog : [docs/backlog.md](docs/backlog.md).

État : **Phases 1 et 2 terminées** : stacks, révisions, variables (stack et service), fichiers associés, déploiement / arrêt / démarrage, jetons API, logs en direct et interface complète des stacks (éditeur Compose, différences, historique, opérations). Contrat OpenAPI 3.1 dans [docs/openapi.json](docs/openapi.json) (servi par `GET /api/v1/openapi.json`) et import des projets Compose déjà présents sur l'hôte.

**Phase 3 (sauvegarde Git et restauration)** : la configuration est sauvegardée dans un dépôt Git unique (HTTPS + jeton), secrets chiffrés avec age, et restaurable sur une console vierge depuis l'assistant d'initialisation. Prochaine étape : Phase 4 (dashboard, supervision).

## API (extrait)

Contrat complet : [docs/openapi.json](docs/openapi.json), généré depuis le code (`npm run build && npm run openapi -w @infra/console`) ; un test vérifie qu'il décrit exactement les routes enregistrées et qu'il est à jour.

Authentification : jeton API (`Authorization: Bearer cdt_…`) ou cookie de session (`POST /api/v1/session`). Les jetons se gèrent depuis une session (`POST /api/v1/api-tokens`, `GET`, `DELETE /{id}`) : ils sont affichés une seule fois, stockés par empreinte, révocables, avec expiration facultative et une portée `read` (GET uniquement) ou `write`. Un jeton ne peut ni gérer les jetons ni modifier le compte administrateur. Toute modification de stack exige `expectedRevision` (409 en cas de conflit).

```bash
# Créer une stack (révision 1) : le Compose doit référencer une image, pas de « build »
POST /api/v1/stacks                        {"name","hostId","compose","variables":{"PORT":"8080","PWD":{"value":"…","sensitive":true}},"adopt":false}
PUT  /api/v1/stacks/{id}/compose           {"expectedRevision":1,"compose":"…"}
PATCH /api/v1/stacks/{id}/variables        {"expectedRevision":2,"set":{"IMAGE_TAG":"1.4.2"},"unset":["OLD"]}
PATCH /api/v1/stacks/{id}/services/{service}/environment   {"expectedRevision":3,"set":{"LOG_LEVEL":"debug"},"unset":["OLD"]}
PUT  /api/v1/stacks/{id}/files/{chemin}    {"expectedRevision":3,"content":"…"}
POST /api/v1/stacks/{id}/deploy            {"revision":4,"pullImages":true}   → 202 + operationId (en-tête Idempotency-Key accepté)
POST /api/v1/stacks/{id}/stop | start
GET  /api/v1/hosts/{id}/projects             projets Compose observés (gérés ou importables)
GET  /api/v1/operations/{id}               état, journal expurgé, images déployées (digests)
GET  /api/v1/stacks/{id}/logs?service=web&tail=100   logs en direct (Server-Sent Events : `lines`, `end`)
GET  /api/v1/backup/status                 sauvegarde Git : état, dernier push confirmé, révisions en attente, erreur
POST /api/v1/backup/sync[?wait=true]       demander une synchronisation (jamais de force push)
```

Les valeurs sensibles ne sont jamais renvoyées par l'API ni écrites dans les journaux d'opération. Un déploiement applique exactement la révision demandée ; une configuration invalide échoue avant toute modification des conteneurs.

## Installation

```bash
cp .env.example .env        # puis définir POSTGRES_PASSWORD (alphanumérique)
docker compose up -d --build
docker compose logs console # relever « Secret d'initialisation »
```

Ouvrir `http://localhost:8080` : l'assistant d'initialisation comporte trois étapes.

1. **Compte** : secret d'initialisation (logs de la console) puis identifiant et mot de passe de l'administrateur unique.
2. **Dépôt Git de sauvegarde** (optionnel, configurable plus tard) : URL HTTPS, identifiant, jeton et branche, avec test de connexion. Si le dépôt contient déjà une sauvegarde, l'assistant propose de la **restaurer** (voir plus bas).
3. **Clé de restauration** : générée et affichée une seule fois (sauf si elle est reprise d'une restauration).

L'agent local s'enrôle seul : la console dépose un jeton à usage unique dans le volume `shared`, supprimé dès l'enrôlement.

Hôte supplémentaire : générer un jeton dans l'interface (« Enrôler un hôte »), puis sur l'hôte cible :

```bash
CONSOLE_URL=wss://console.exemple.org/agent/ws ENROLLMENT_TOKEN=<jeton> docker compose -f compose.agent.yaml up -d --build
```

## Sauvegarde Git et restauration

**Ce qui est sauvegardé** (dépôt dédié, de préférence privé) : paramètres, stacks (Compose, variables, fichiers associés) et hôtes logiques. **Non sauvegardé** : volumes et données des applications, base PostgreSQL de la console, métriques, caches Trivy, journaux, sessions, jetons API, compte administrateur et identifiants Git. Le compte administrateur n'est jamais restauré : on le recrée avec le secret d'initialisation.

| Chemin | Contenu |
| --- | --- |
| `manifest.yaml` | version du format, identifiant d'installation, révision de configuration |
| `settings/config.yaml`, `environments/default.yaml` | paramètres, hôtes logiques |
| `stacks/<id>/stack.yaml`, `compose.yaml`, `variables.yaml`, `files/…` | configuration non sensible |
| `secrets/<id>/variables.age`, `compose.yaml.age`, `files/….age` | éléments sensibles chiffrés (age) |

- **Secrets** : les variables « sensibles », les fichiers marqués sensibles et les Compose marqués « chiffrés » sont chiffrés avec la clé publique de restauration. La clé privée est montrée une seule fois et n'est jamais stockée. Sans elle, les secrets du dépôt sont irrécupérables. Un secret retiré du dépôt reste dans l'historique Git. Aucun scanner ne détecte tous les secrets : classez explicitement ce qui est sensible.
- **Jeton Git** : chiffré (AES-256-GCM) avec une clé maître locale (`/data/master.key`, volume `console-data`), transmis à `git` par `GIT_ASKPASS` (jamais dans une URL, un argument ni `.git/config`). Seul HTTPS est accepté, les certificats TLS sont vérifiés ; pour un serveur Git avec une autorité interne, monter le certificat dans le conteneur `console` et renseigner `GIT_CA_FILE`.
- **Synchronisation** : chaque changement incrémente une révision de configuration ; les changements rapprochés sont regroupés en un commit, poussé sans jamais forcer. Une panne Git n'empêche pas de gérer les stacks : nouvelle tentative avec temporisation progressive (30 s à 30 min). Un push n'est présumé réussi qu'une fois confirmé par le distant (`GET /api/v1/backup/status`).
- **Divergence** : si le dépôt a évolué ailleurs, ou s'il appartient à une autre installation, la synchronisation est **bloquée** (aucun écrasement) jusqu'à action explicite. Les fichiers étrangers du dépôt (README…) sont préservés.
- **Restauration** (assistant d'initialisation, ou API `POST /api/v1/backup/restore/preview` puis `/restore`) : le dépôt est analysé dans un espace temporaire (format, chemins, liens symboliques, intégrité), déchiffré avec la clé fournie, puis importé **sans démarrer ni arrêter de conteneur**. Les agents ne sont pas restaurés : chaque hôte de la sauvegarde est associé à un hôte enrôlé. Les stacks restaurées sont « jamais déployées » ; leur premier déploiement peut reprendre un projet Compose déjà présent. La console reprend l'identifiant d'installation et la clé de restauration du dépôt, et continue son historique en avance rapide. Sur une installation existante, les stacks en conflit ne sont remplacées que sur demande explicite (nouvelle révision, rien n'est supprimé).

## Développement

Node.js 24 (voir `mise.toml`) et npm.

```bash
npm install
npm run lint
npm run build
npm run typecheck
npm test
```

Les tests d'intégration de la console nécessitent une base PostgreSQL jetable :

```bash
docker run -d --name infra-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/test npm test
```

Attention : ces tests suppriment le schéma `public` de la base ciblée.

Les tests de l'agent avec un vrai Docker (Linux, `DOCKER_INTEGRATION=1`) tournent en CI. En local sous Windows ou macOS, les lancer dans un conteneur Linux avec le socket Docker et un dossier de travail monté au même chemin :

```bash
docker build --target build -t infra-build-test .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /tmp/infra-it:/tmp/infra-it \
  -e DOCKER_INTEGRATION=1 -e INFRA_IT_DIR=/tmp/infra-it infra-build-test \
  sh -c "apk add --no-cache docker-cli docker-cli-compose && npm test -w @infra/agent"
```

TypeScript est volontairement limité à la version 6 : `vue-tsc` ne fonctionne pas encore avec la 7.

## Limites actuelles

- Pas de retour arrière en un clic : on redéploie une ancienne révision depuis l'onglet Historique (la configuration est restaurée, pas les données).
- Les logs en direct sont bornés (5 flux par hôte, 1 h par flux, 2 000 lignes/s, 5 000 lignes conservées dans le navigateur) et affichés tels que produits par les conteneurs : les valeurs sensibles n'y sont pas masquées.
- L'interface n'a été vérifiée que par navigation automatisée (pas de contrôle visuel de la mise en page, ni sur mobile) ; le bundle JavaScript fait environ 580 Ko à cause de l'éditeur.
- L'édition des variables d'un service conserve commentaires, ordre et expressions `${…}`, mais refuse les alias YAML et les clés de fusion `<<`. Avec une indentation de 4 espaces et des listes non indentées, la bibliothèque YAML décale les listes de 2 espaces. Les valeurs écrites dans `environment` restent dans le texte du Compose : mettre les secrets dans des variables de stack sensibles (`${NOM}`).
- Les valeurs de variables sont stockées en clair dans PostgreSQL (le chiffrement concerne l'export Git de la Phase 3) et transmises à l'agent par la connexion WebSocket : utiliser `wss://` hors réseau de confiance.
- Import d'un projet existant (`adopt: true`) : la console n'en reconstitue pas le Compose, vous le fournissez. Le premier déploiement recrée les conteneurs dont la configuration diffère (prévisualisation dans le journal) et ne supprime jamais les services absents du Compose fourni.
- Le Compose doit utiliser des images préconstruites : `build` et `include` sont rejetés.
- L'espace de travail de l'agent (`WORKSPACE_DIR`, défaut `/var/lib/console-docker/workspace`) est monté au même chemin absolu sur l'hôte et dans le conteneur ; ne pas le changer sans adapter le montage.
- Rotation de la clé de restauration non implémentée. Les révisions précédentes d'une stack ne sont pas dans Git (seul l'état courant est sauvegardé) : une restauration crée une révision 1.
- Sauvegarde Git : le chemin HTTPS + jeton est vérifié de bout en bout contre un serveur Gitea en HTTPS avec autorité interne ; les autres hébergeurs (GitHub, GitLab…) n'ont pas été testés. Le jeton nécessite des droits d'écriture. Les valeurs de variables sensibles sont chiffrées dans Git mais restent en clair dans PostgreSQL.
- Une console qui perd son volume `console-data` (clé maître) doit se voir ressaisir le jeton Git. Changer le dépôt ou la branche réinitialise la synchronisation ; revenir sur un dépôt déjà sauvegardé par cette installation exige de le restaurer.
- Aucun HTTPS intégré : placer la console derrière un reverse proxy TLS et activer `SECURE_COOKIES=true`. Hors réseau de confiance, l'agent doit utiliser `wss://`.
- L'agent monte le socket Docker : cela équivaut à un accès root à l'hôte.
