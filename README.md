# Console Docker, sécurité et supervision

Outil auto-hébergé de gestion de stacks Docker. Cadrage complet : [project.md](project.md). Décisions techniques : [docs/adr/0001-architecture.md](docs/adr/0001-architecture.md). Backlog : [docs/backlog.md](docs/backlog.md). Exploitation : [docs/exploitation.md](docs/exploitation.md). Exemples d'API : [docs/api-exemples.md](docs/api-exemples.md).

État : **Phases 1 et 2 terminées** : stacks, révisions, variables (stack et service), fichiers associés, déploiement / arrêt / démarrage, jetons API, logs en direct et interface complète des stacks (éditeur Compose, différences, historique, opérations). Contrat OpenAPI 3.1 dans [docs/openapi.json](docs/openapi.json) (servi par `GET /api/v1/openapi.json`) et import des projets Compose déjà présents sur l'hôte.

**Phase 3 (sauvegarde Git et restauration)** : la configuration est sauvegardée dans un dépôt Git unique (HTTPS + jeton), secrets chiffrés avec age, et restaurable sur une console vierge depuis l'assistant d'initialisation.

**Phase 4 (supervision)** : tableau de bord (agents, stacks, conteneurs, healthchecks, alertes), métriques CPU / mémoire / réseau avec rétention bornée, filtres par hôte et par stack. **Phase 5 (images et sécurité)** : scans Trivy, suivi des images (registres publics et privés) et alertes associées. Prochaine étape : Phase 6 (livraison).

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
GET  /api/v1/dashboard[?hostId=…&stackId=…]   agents, stacks (état + raison), conteneurs, utilisation, alertes
GET  /api/v1/stacks/{id}/metrics?range=1h|6h|24h|7d[&service=…]   séries CPU / mémoire / réseau
GET  /api/v1/applications                  applications gérées et observées (état, utilisation, images, mises à jour)
GET  /api/v1/hosts/{id}/projects/{nom}     fiche en lecture seule d'un projet Compose (+ /metrics, + /logs?container=…)
GET  /api/v1/dashboard/overview?range=…    totaux CPU / mémoire / réseau, top 5, utilisation des hôtes
GET  /api/v1/backup/status                 sauvegarde Git : état, dernier push confirmé, révisions en attente, erreur
POST /api/v1/backup/sync[?wait=true]       demander une synchronisation (jamais de force push)
```

Les valeurs sensibles ne sont jamais renvoyées par l'API ni écrites dans les journaux d'opération. Un déploiement applique exactement la révision demandée ; une configuration invalide échoue avant toute modification des conteneurs.

## Installation

```bash
cp .env.example .env        # puis définir POSTGRES_PASSWORD (alphanumérique)
docker compose up -d          # images publiées sur ghcr.io (IMAGE_TAG, « latest » par défaut)
docker compose logs console # relever « Secret d'initialisation »
```

Ouvrir `http://localhost:8080` : l'assistant d'initialisation comporte trois étapes.

1. **Compte** : secret d'initialisation (logs de la console) puis identifiant et mot de passe de l'administrateur unique.
2. **Dépôt Git de sauvegarde** (optionnel, configurable plus tard) : URL HTTPS, identifiant, jeton et branche, avec test de connexion. Si le dépôt contient déjà une sauvegarde, l'assistant propose de la **restaurer** (voir plus bas).
3. **Clé de restauration** : générée et affichée une seule fois (sauf si elle est reprise d'une restauration).

L'agent local s'enrôle seul : la console dépose un jeton à usage unique dans le volume `shared`, supprimé dès l'enrôlement.

Hôte supplémentaire : générer un jeton dans l'interface (« Enrôler un hôte »), puis sur l'hôte cible :

```bash
CONSOLE_URL=wss://console.exemple.org/agent/ws ENROLLMENT_TOKEN=<jeton> docker compose -f docker-compose.agent.yml up -d
```

## Interface

En-tête (nom du produit défini à un seul endroit, `packages/web/src/brand.ts`, indicateur de santé global, menu utilisateur avec thème clair / sombre / automatique), menu latéral repliable et contenu pleine largeur.

- **Tableau de bord** : indicateurs, anneaux (applications, conteneurs, images), courbes CPU / mémoire / réseau avec animation à l'affichage, utilisation des machines hôtes, top 5 CPU et mémoire, alertes. Un conteneur terminé avec le code 0 est « terminé », jamais en erreur.
- **Applications** : une tuile par projet Compose. Les applications **gérées** par la console (icône pleine) se distinguent de celles **observées**, qui tournent sans que la console ait leur Compose (bordure en pointillés, bouton « Prendre en charge »). Chaque tuile indique état, conteneurs, CPU / mémoire, images avec badges de vulnérabilités (jamais de badge à zéro), mises à jour et boutons démarrer / arrêter / déployer. Un clic sur une application **observée** ouvre une **fiche en lecture seule** (`/hosts/{hôte}/projects/{nom}`) : conteneurs avec ports, réseaux, montages et libellés Compose (dossier et fichiers d'origine, chemins de l'hôte), sécurité des images, métriques et logs en direct d'un conteneur. Les variables d'environnement des conteneurs ne sont jamais lues, et le contenu du fichier Compose n'est pas accessible à l'agent : « Prendre en charge » reste le moyen de la gérer.
- **Images** : tableau des images avec vulnérabilités par gravité, détails et scan à la demande.
- **Hôtes** : une tuile par machine avec ses ressources (CPU, mémoire, disque de la partition de l'espace de travail) et son espace **Docker** comme `docker system df` (images, conteneurs, volumes, cache de build : nombre, taille, part récupérable), relevé toutes les 10 minutes et à la demande. Le bouton **Nettoyer…** ouvre une boîte de dialogue (voir ci-dessous).
- **Statut** : agents (état, versions), sauvegarde Git, sécurité des images.
- **Paramètres de l'application** (menu latéral, `/settings`) : onglet « Sauvegarde Git » (dépôt, jeton, clé de restauration, synchronisation) et onglet « Sécurité des images » (périodicité des scans et de la recherche de versions, **gravité minimale signalée** et prise en compte des vulnérabilités « inconnues », registres d'images). Le seuil s'applique à la lecture (compteurs, badges, alertes, graphiques) : les scans restent complets et un changement est immédiat, sans nouveau scan. Le graphique « Images » du tableau de bord ne compte que les CVE critiques et élevées.
- **Paramètres de l'utilisateur** (menu utilisateur en haut à droite, `/account`) : mot de passe (et identifiant) de l'administrateur, thème clair / sombre.

Les graphiques utilisent Apache ECharts (chargé à la demande) et les icônes Font Awesome Free. L'utilisation de la **machine hôte** (CPU global, mémoire hors cache, disque de la partition de l'espace de travail) est mesurée par l'agent depuis `/proc` : elle n'apparaît qu'avec un agent à jour, sur un hôte Linux.

## Nettoyage d'un hôte

Réservé à la **session de l'administrateur** (un jeton API, même en écriture, ne peut rien supprimer) et tracé dans le journal d'audit. La boîte de dialogue propose, avec un aperçu exact de ce qui sera supprimé (noms, tailles, ancienneté) et des avertissements explicites :

| Catégorie | Options |
| --- | --- |
| Conteneurs arrêtés | tous, ou plus anciens que 7 j / 1 mois / 3 mois / N jours (date de **création**) |
| Images | sans nom, ou toutes celles qu'aucun conteneur n'utilise (mêmes ancienneté) |
| Réseaux | inutilisés |
| Volumes | anonymes, ou **tous** les volumes inutilisés (nommés compris) : suppression définitive, confirmée en saisissant le nom de l'hôte |
| Cache de build | tout, ou plus ancien que 7 j / 1 mois / 3 mois / N jours (dernière **utilisation**), avec un volume à conserver |

Garanties : Docker n'ayant pas de mode simulation, l'aperçu vient d'un relevé de l'agent de moins de 5 minutes. La console recalcule la sélection ; l'agent ne supprime que ce qui est **encore** inutilisé et non protégé, **sans jamais forcer** (Docker refuse ce qui sert). Les conteneurs de la console et de l'agent, le cache de Trivy et l'image de Trivy ne sont jamais proposés ; supprimer un conteneur ne supprime pas ses volumes. Un nettoyage à la fois par hôte, refusé pendant un déploiement. Pendant le nettoyage, la boîte de dialogue affiche l'**avancement** : phase en cours (conteneurs, réseaux, images, volumes), élément en cours de suppression, compteurs, espace libéré jusqu'ici et durée ; le cache de build, supprimé d'un seul bloc par Docker, est signalé comme tel. L'espace libéré est une **estimation** (mesure exacte de Docker pour le cache de build). Il faut un agent à jour ; les routes sont `GET /api/v1/hosts/{id}/disk-usage`, `POST …/prune/preview` et `POST …/prune`.

## Supervision

Le tableau de bord (page d'accueil) se rafraîchit toutes les 10 s et se filtre par hôte et par stack (`GET /api/v1/dashboard`).

- **États d'une stack** : `en marche`, `dégradée` (conteneur planté ou en échec de healthcheck, service absent, redémarrage en cours), `arrêtée`, `jamais déployée` et **`inconnue`**. Un hôte hors ligne ou une observation de plus de 3 minutes donnent « inconnue », **jamais « arrêtée »** : la dernière observation est conservée et datée, les conteneurs ont pu continuer à tourner.
- **Healthchecks** : ceux de Docker uniquement. « Sans healthcheck » (non configuré) est distingué de « en échec ». Un conteneur terminé avec le code 0 est vu comme une tâche achevée (migration, init), pas comme une panne ; les services sous `profiles` ne sont pas attendus. Les **contrôles HTTP externes ne sont pas inclus** (décision du porteur).
- **Alertes** (calculées à la lecture, triées par gravité) : agent hors ligne, observation périmée, stack dégradée ou arrêtée, healthcheck en échec, redémarrages répétés (≥ 3 et démarrage récent), sauvegarde Git en échec ou bloquée, opération au résultat inconnu. Ajoutées en Phase 5 : vulnérabilités critiques, scan en échec ou périmé, mise à jour d'image disponible, vérification du registre en échec.
- **Métriques** (onglet « Métriques » d'une stack, `GET /api/v1/stacks/{id}/metrics`) : CPU (100 % = un cœur), mémoire (hors cache de pages inactif, comme `docker stats`), débits réseau reçus et émis. Collecte **toutes les 30 s**, conservation **7 jours**, ajustables avec `METRICS_INTERVAL_SEC` (5–3600) et `METRICS_RETENTION_DAYS` (1–365). Les courbes sont agrégées à 240 points maximum ; un débit est inconnu après un redémarrage du conteneur (compteur remis à zéro) et les trous ne sont pas interpolés. Ordre de grandeur de stockage : environ 100 octets par conteneur et par échantillon, soit quelques Mo par conteneur et par semaine à 30 s.

## Images et sécurité

Page « Images » (`GET /api/v1/images`) et onglet « Sécurité et versions » de chaque stack.

- **Scans Trivy** : l'agent exporte l'image (`docker save`) dans le répertoire de travail, puis lance Trivy dans un **conteneur éphémère restreint** (sans socket Docker, capacités retirées sauf `DAC_OVERRIDE`, `no-new-privileges`, système de fichiers en lecture seule, mémoire et processus bornés). Le cache de la base de vulnérabilités est un volume persistant (`console-docker-trivy-cache`). Seul un résumé normalisé et borné remonte à la console (compteurs exacts, 2000 vulnérabilités au plus) ; la configuration et les variables d'environnement de l'image ne sont jamais transmises. Un scan est identifié par le contenu de l'image (identifiant + plateforme) : deux hôtes avec la même image partagent le résultat. Un seul scan par contenu et **un seul scan à la fois, tous hôtes confondus** (file unique, dans l'ordre des demandes, ce qui borne aussi l'espace disque utilisé). Un scan demandé est d'abord « en attente » (avec son rang dans la file), puis « en cours ». Le bouton **Scanner tout…** de la page Images ouvre une boîte de dialogue : périmètre (jamais scannées, jamais scannées ou périmées, toutes), applications gérées seulement ou non, décompte en direct, puis mise en file ; une bannière montre la progression et permet d'annuler les scans encore en attente (celui en cours va à son terme). Les 5 derniers scans de chaque image sont conservés (`POST /api/v1/images/scans`, `DELETE /api/v1/images/scans/queue`).
- **États** : `jamais scannée`, `en attente`, `en cours`, `échec`, `sans vulnérabilité connue`, `vulnérable`. « Sans vulnérabilité » n'est jamais confondu avec « jamais scannée » ni « échec » : le dernier résultat réussi reste affiché et daté même si la dernière tentative a échoué. La date de la base Trivy est affichée ; un système en fin de vie est signalé.
- **Planification** (`GET/PUT /api/v1/settings/security`) : re-scan des résultats plus anciens que l'intervalle (24 h par défaut, 0 = désactivé), échecs retentés après une heure au plus. Les images hors stack gérée ne sont scannées qu'à la demande. **Un résultat de scan ne bloque jamais un déploiement et rien n'est redéployé automatiquement.**
- **Suivi des images** : pour chaque service, la console compare le contenu déployé avec celui du registre (même tag, contenu différent) et cherche de nouveaux tags selon une politique (`même tag`, `patch`, `mineure`, `majeure` ou expression régulière validée), enregistrée dans la sauvegarde Git. Les tags non interprétables donnent des candidats signalés comme incertains. Le contenu est comparé par digest, puis par couches (`diff_ids`) pour ne pas signaler de faux changement quand le moteur d'images (containerd) ou un push a seulement réempaqueté l'image. Une erreur du registre conserve la dernière observation, datée.
- **Registres** : Docker Hub, GHCR et registres privés (HTTP Basic ou jeton Bearer). Les identifiants sont chiffrés (AES-256-GCM, clé maître locale), jamais renvoyés par l'API ni sauvegardés dans Git, et uniquement envoyés au registre ou à son serveur d'authentification légitime. Le HTTP en clair exige l'option « HTTP non sécurisé » du registre ; pour une autorité interne, monter le certificat et renseigner `REGISTRY_CA_FILE`.
- **Variables** : `TRIVY_IMAGE` (image de Trivy, version épinglée par défaut), `TRIVY_MEMORY` (2g), `TRIVY_MAX_IMAGE_GB` (taille maximale d'une image scannée, 10 Gio par défaut), `REGISTRY_CA_FILE`.
- **Limites** : les registres doivent être joignables depuis la console ; la détection de nouveaux tags est heuristique (tags non sémantiques) ; les mises à jour sont signalées, pas appliquées.

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

## Sécurité

Revue du §14 de [project.md](project.md) (6 novembre 2026) :

- **Compte** : un seul administrateur, mot de passe haché en Argon2id (jamais chiffré). Sessions en cookie `HttpOnly`, `SameSite=Strict` (`Secure` avec `SECURE_COOKIES=true`), stockées par empreinte. Les requêtes modifiantes dont l'en-tête `Origin` ne correspond pas à l'hôte sont refusées ; aucun CORS n'est ouvert. En-têtes `Content-Security-Policy`, `X-Frame-Options` et `nosniff`. Les tentatives de connexion et d'authentification par jeton échouées sont limitées (429).
- **Jetons** : API et enrôlement aléatoires, affichés une fois, stockés par empreinte SHA-256, révocables, avec expiration.
- **Agent** : connexion sortante authentifiée par un secret propre à l'agent ; `wss://` obligatoire hors réseau de confiance. L'agent n'accepte que les messages typés du protocole (aucun shell, aucune commande arbitraire), lance `docker` avec des arguments structurés, des délais et des sorties bornées. **Chaque demande porte un identifiant et une échéance de 10 minutes : l'agent ignore une demande déjà reçue et refuse une demande expirée** ; l'échéance est jugée à l'heure de la console (décalage mesuré à la connexion), sans dépendre de la justesse de l'horloge de l'hôte.
- **Auto-protection** : l'agent refuse d'arrêter ou de redéployer le projet Compose qui le fait tourner (détecté depuis son propre conteneur, y compris si le nom d'hôte est imposé ; il l'écrit dans ses logs s'il ne le retrouve pas) ainsi que ceux listés dans `PROTECTED_PROJECTS` (séparés par des virgules). Le projet de la console doit y figurer s'il tourne sur un autre projet Compose que l'agent. Le remplacement automatique de l'outil par lui-même n'est pas proposé : mise à jour manuelle (`docker compose pull && up -d`).
- **Fichiers** : chemins, liens symboliques et archives contrôlés à l'import et à la restauration ; le `.env` d'une stack contient ses secrets en clair dans l'espace de travail de l'hôte (permissions 0600, nécessaire à Compose) : quiconque est root sur l'hôte les lit ; secrets masqués dans les journaux.
- **Exposition** : seul le port de la console est publié ; PostgreSQL et le socket Docker ne le sont pas. La console tourne sans privilèges (utilisateur `node`).
- **À savoir** : le contrôle du démon Docker donne des capacités très élevées sur l'hôte, **même avec un socket monté en lecture seule** (créer un conteneur privilégié équivaut à root). L'agent s'exécute donc en root et doit être traité comme tel. Les scans Trivy, eux, n'ont pas accès au socket.

## Publication des images

Pousser un tag de version déclenche le workflow [release.yml](.github/workflows/release.yml), qui construit la console et l'agent (linux/amd64 et linux/arm64) et les publie sur le registre GitHub :

```bash
git tag 1.1.1 && git push origin 1.1.1
# → ghcr.io/valcriss/infrastructure-console:1.1.1 (+ 1.1, 1, latest)
# → ghcr.io/valcriss/infrastructure-agent:1.1.1   (+ 1.1, 1, latest)
```

Une préversion (`1.2.0-rc.1`) ne reçoit que son propre tag, jamais `latest`. En production, épingler `IMAGE_TAG=1.1.1` dans `.env`. Au premier envoi, GitHub crée les paquets en privé : les rendre publics (Paramètres du paquet → visibilité) ou faire `docker login ghcr.io` sur chaque hôte. Pour construire localement : `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

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
- Supervision : pas de métriques de l'hôte lui-même (CPU/mémoire globale, disque) mais seulement des conteneurs ; pas de notifications externes (les alertes ne sont visibles que dans l'interface et l'API) ; pas d'historique des alertes ni des changements d'état ; l'environnement est unique (« standalone »). L'état « dégradée » d'une stack repose sur le dernier inventaire (jusqu'à 60 s de retard). La détection de redémarrages en boucle est une heuristique (compteur Docker et date de démarrage).
- Une console qui perd son volume `console-data` (clé maître) doit se voir ressaisir le jeton Git. Changer le dépôt ou la branche réinitialise la synchronisation ; revenir sur un dépôt déjà sauvegardé par cette installation exige de le restaurer.
- Aucun HTTPS intégré : placer la console derrière un reverse proxy TLS et activer `SECURE_COOKIES=true`. Hors réseau de confiance, l'agent doit utiliser `wss://`.
- L'agent monte le socket Docker : cela équivaut à un accès root à l'hôte.
