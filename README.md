# Console Docker, sécurité et supervision

Outil auto-hébergé de gestion de stacks Docker. Cadrage complet : [project.md](project.md). Décisions techniques : [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md). Backlog : [docs/backlog.md](docs/backlog.md).

État : **Phase 1 terminée**, **Phase 2 en cours** : stacks, révisions, variables, fichiers associés, déploiement / arrêt / démarrage par l'API. Pas encore d'éditeur dans l'interface, de logs en direct ni de jetons API (authentification par session pour l'instant).

## API (extrait)

Authentification par cookie de session (`POST /api/v1/session`). Toute modification exige `expectedRevision` (409 en cas de conflit).

```bash
# Créer une stack (révision 1) : le Compose doit référencer une image, pas de « build »
POST /api/v1/stacks                        {"name","hostId","compose","variables":{"PORT":"8080","PWD":{"value":"…","sensitive":true}}}
PUT  /api/v1/stacks/{id}/compose           {"expectedRevision":1,"compose":"…"}
PATCH /api/v1/stacks/{id}/variables        {"expectedRevision":2,"set":{"IMAGE_TAG":"1.4.2"},"unset":["OLD"]}
PUT  /api/v1/stacks/{id}/files/{chemin}    {"expectedRevision":3,"content":"…"}
POST /api/v1/stacks/{id}/deploy            {"revision":4,"pullImages":true}   → 202 + operationId (en-tête Idempotency-Key accepté)
POST /api/v1/stacks/{id}/stop | start
GET  /api/v1/operations/{id}               état, journal expurgé, images déployées (digests)
```

Les valeurs sensibles ne sont jamais renvoyées par l'API ni écrites dans les journaux d'opération. Un déploiement applique exactement la révision demandée ; une configuration invalide échoue avant toute modification des conteneurs.

## Installation

```bash
cp .env.example .env        # puis définir POSTGRES_PASSWORD (alphanumérique)
docker compose up -d --build
docker compose logs console # relever « Secret d'initialisation »
```

Ouvrir `http://localhost:8080`, saisir le secret d'initialisation et créer le compte administrateur. L'agent local s'enrôle seul : la console dépose un jeton à usage unique dans le volume `shared`, supprimé dès l'enrôlement.

Hôte supplémentaire : générer un jeton dans l'interface (« Enrôler un hôte »), puis sur l'hôte cible :

```bash
CONSOLE_URL=wss://console.exemple.org/agent/ws ENROLLMENT_TOKEN=<jeton> docker compose -f compose.agent.yaml up -d --build
```

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

- Phase 2 incomplète : pas d'édition des variables d'environnement par service (préservant les commentaires YAML), pas de jetons API, pas d'interface pour les stacks, pas de logs de conteneurs, pas de retour arrière en un clic (on redéploie une ancienne révision).
- Les valeurs de variables sont stockées en clair dans PostgreSQL (le chiffrement concerne l'export Git de la Phase 3) et transmises à l'agent par la connexion WebSocket : utiliser `wss://` hors réseau de confiance.
- Le Compose doit utiliser des images préconstruites : `build` et `include` sont rejetés.
- L'espace de travail de l'agent (`WORKSPACE_DIR`, défaut `/var/lib/console-docker/workspace`) est monté au même chemin absolu sur l'hôte et dans le conteneur ; ne pas le changer sans adapter le montage.
- Pas encore de sauvegarde Git (Phase 3). La clé de restauration (age) est générée à l'initialisation et montrée une seule fois ; la console n'en conserve que la partie publique. Rotation de la clé non implémentée.
- Aucun HTTPS intégré : placer la console derrière un reverse proxy TLS et activer `SECURE_COOKIES=true`. Hors réseau de confiance, l'agent doit utiliser `wss://`.
- L'agent monte le socket Docker : cela équivaut à un accès root à l'hôte.
