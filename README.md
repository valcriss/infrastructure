# Console Docker, sécurité et supervision

Outil auto-hébergé de gestion de stacks Docker. Cadrage complet : [project.md](project.md). Décisions techniques : [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md). Backlog : [docs/backlog.md](docs/backlog.md).

État : **Phase 1 en cours** (installation, compte administrateur, agent, inventaire Docker).

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

TypeScript est volontairement limité à la version 6 : `vue-tsc` ne fonctionne pas encore avec la 7.

## Limites actuelles

- Pas encore de gestion de stacks, de variables, d'API de déploiement ni de logs (Phase 2).
- Pas encore de clé de restauration ni de sauvegarde Git (Phase 3).
- Changement d'identifiants administrateur non implémenté.
- Aucun HTTPS intégré : placer la console derrière un reverse proxy TLS et activer `SECURE_COOKIES=true`. Hors réseau de confiance, l'agent doit utiliser `wss://`.
- L'agent monte le socket Docker : cela équivaut à un accès root à l'hôte.
