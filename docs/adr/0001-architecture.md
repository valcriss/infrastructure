# ADR 0001 — Architecture et choix techniques initiaux

Statut : **Validé pour la stack** (Node.js, Vue.js, Tailwind, PostgreSQL), le reste est **Proposé** — 6 novembre 2026
Référence : `project.md` §16 et §17 (Phase 0).

Les versions exactes ne sont volontairement pas fixées ici : elles seront choisies et vérifiées dans les documentations officielles au démarrage de la Phase 1 (versions LTS/stables supportées). Les bibliothèques nommées ci-dessous sont des candidats à confirmer à ce moment-là.

## 1. Principes

- Monolithe modulaire pour la console, processus séparé et léger pour l'agent.
- Réversibilité : chaque choix est isolé derrière une interface (Docker, registre, Git, stockage, transport).
- Pas de broker externe, pas de microservices : la file de tâches vit dans PostgreSQL.
- Les secrets ne sortent jamais en clair vers Git, logs, diffs ou API ordinaire.
- TypeScript strict partout, avec des types partagés entre console, agent et frontend.

## 2. Décisions

| Sujet | Choix | Statut | Raisons / notes |
| --- | --- | --- | --- |
| Runtime console et agent | **Node.js (LTS) + TypeScript** | Validé | Un seul langage du frontend à l'agent, types et schémas partagés |
| Base de données | **PostgreSQL** | Validé | Service ajouté au `compose.yaml` de livraison (volume persistant, healthcheck) |
| Frontend | **Vue 3 + Vite + Tailwind CSS** | Validé | Vue Router et Pinia ; servi en statique par la console |
| Éditeur YAML | **CodeMirror 6** (YAML, vue des différences) | Proposé | Léger, intégration Vue simple ; Monaco écarté (poids) |
| Framework HTTP | **Fastify** | Proposé | Validation par schéma, génération OpenAPI, bonnes performances |
| Accès aux données | **Drizzle ORM** ou **Kysely**, migrations versionnées | Proposé | Typage fort, SQL lisible ; choix final en Phase 1 |
| File de tâches | Table `operations` + `SELECT … FOR UPDATE SKIP LOCKED`, workers internes ; `LISTEN/NOTIFY` pour réveiller | Proposé | Pas de broker (cf. `project.md` §5), reprise après redémarrage |
| Contrat et validation | **Zod** (ou équivalent) comme source des types et de l'OpenAPI | Proposé | Un schéma unique pour API, protocole agent et format Git |
| Transport agent → console | **WebSocket sortant (TLS)**, messages JSON typés et versionnés (`ws`) | Proposé | Connexion sortante unique, traverse proxys et NAT, streaming de logs |
| Docker | **Dockerode** ou appels directs à l'API Engine | Proposé | Inventaire, états, logs, métriques |
| Compose | CLI **`docker compose`** en arguments structurés (jamais de shell) ; `config` pour valider | Proposé | Compatibilité maximale ; l'image de l'agent embarque le plugin Compose |
| Édition YAML | Bibliothèque conservant l'arbre de nœuds et les commentaires (ex. `yaml`, API `Document`) | Proposé | Exigence §8 : préserver la forme |
| Chiffrement des secrets | **age** via une bibliothèque JS éprouvée, clé de restauration exportable | Proposé | À confirmer : format compatible avec l'outil `age` |
| Mots de passe | **Argon2id** (module natif Node si disponible, sinon bibliothèque éprouvée) | Proposé | Hash adapté (§14) |
| Git | CLI `git` en arguments structurés, SSH et/ou HTTPS | Proposé | Pas de force push, clés d'hôte vérifiées |
| Trivy | Conteneur de travail éphémère lancé par l'agent, cache sur volume dédié | Proposé | Agent léger au repos |
| Registres (MVP) | Abstraction + **Registry HTTP API v2** testée sur un registre local contrôlé ; Docker Hub et GHCR ensuite | Proposé | Périmètre honnête (§11) |
| Gestionnaire de paquets | **npm** en monorepo (workspaces, `package-lock.json` commité) | Validé | Paquets : `console`, `agent`, `web`, `shared` |
| Tests | **Vitest** (unitaires), tests d'intégration avec Docker/PostgreSQL réels (Testcontainers ou Compose de test), **Playwright** (E2E) | Proposé | Ressources isolées et nettoyées (§18) |
| Cible d'hôtes | Linux, Docker Engine + plugin Compose | Proposé | Windows ouvert |

## 3. Conséquences du choix Node.js / PostgreSQL

- **Empreinte de l'agent** : un runtime Node consomme plus de mémoire qu'un binaire statique. Mitigation : agent sans framework lourd, image minimale, mesure de la consommation au repos dès la Phase 1 (objectif à fixer après mesure), possibilité de revoir l'agent plus tard grâce au protocole versionné.
- **Installation** : le Compose de livraison contient désormais trois services minimum (console, agent, PostgreSQL) plus les volumes (données PostgreSQL, travail de l'agent, cache Trivy).
- **Sauvegarde** : la base PostgreSQL n'est pas sauvegardée dans Git (cf. `project.md` §12) ; seul l'export de configuration l'est. La sauvegarde de la base opérationnelle reste hors périmètre MVP et doit être documentée.
- **Migrations** : appliquées au démarrage de la console avec verrou consultatif PostgreSQL pour éviter une double exécution.
- **Unicité de l'administrateur** : garantie par contrainte en base (index unique partiel ou ligne singleton), pas seulement par le code.
- **Sécurité de la chaîne d'approvisionnement** : fichier de verrouillage commité, versions épinglées, audit des dépendances en CI, images de livraison versionnées.

## 4. Découpage logique

```
Navigateur ──HTTPS──> Console (API, UI, planificateur, workers, sauvegarde Git) ──> PostgreSQL
                          ^
                          | WebSocket sortant authentifié
                      Agent (par hôte) ──> Docker local, docker compose, Trivy (conteneur)
```

Modules de la console : `auth`, `stacks` (révisions, variables, fichiers), `operations`, `hosts/agents`, `observed` (état observé), `scans`, `imagewatch`, `backup` (export, Git, restauration), `audit`, `api`, `web`.

Interface d'environnement (frontière Swarm) : `deploy(stack, revision)`, `stop`, `start`, `observe`, `capabilities`. L'adaptateur standalone est le seul à connaître conteneurs et Compose.

## 5. Points techniques obligatoires

- **Chemins de bind mount** : l'agent monte son espace de travail au même chemin absolu dans le conteneur et sur l'hôte. Test d'intégration avec un fichier relatif monté.
- **Opérations** : une opération capture une révision figée ; verrou par stack ; états `pending|running|succeeded|failed|unknown` ; aucun rejeu automatique d'une commande de résultat inconnu.
- **Protocole agent** : version de protocole, identifiant, capacités, heartbeat, reconnexion avec backoff, actions typées uniquement, horodatage et nonce contre rejeux et demandes expirées.
- **Enrôlement** : jeton à usage unique et expirant ; la console remet ensuite des identifiants propres à l'agent, révocables.
- **Auto-protection** : la console et son agent refusent d'arrêter ou redéployer leur propre stack depuis l'interface (§14).
- **Initialisation** : secret d'initialisation temporaire généré localement et affiché dans les logs de la console ; création atomique de l'admin.
- **Processus enfants** : arguments structurés, délais, sortie bornée, jamais de shell (§14).

## 6. Schéma de sauvegarde Git (v1)

Voir `project.md` §12 pour l'arborescence. `manifest.yaml` contient `formatVersion`, `installationId`, `configRevision`. Toute évolution passe par une migration documentée et testée. Secrets sous `secrets/` au format age.

## 7. Hypothèses à documenter lors de l'implémentation

1. Un seul processus console ; pas de haute disponibilité.
2. Métriques : collecte toutes les 30 s, rétention 7 jours, paramétrables.
3. Un seul agent par hôte ; plusieurs hôtes via plusieurs agents.
4. `build`, `include` et Compose multiples rejetés explicitement au MVP.

## 8. Décisions prises depuis (6 novembre 2026)

- **Authentification Git** : HTTPS avec jeton uniquement (pas de SSH). Le jeton est chiffré par une clé maître locale et transmis à `git` par `GIT_ASKPASS`.
- **Compte administrateur et restauration** : le compte est créé par l'assistant d'initialisation (secret affiché dans les logs) ; ni le compte ni son hash ne sont sauvegardés. Le dépôt Git se configure dans ce même assistant, qui propose la restauration si le dépôt contient une sauvegarde.
- **Clé de restauration** : générée après la configuration du dépôt (ou reprise de celle du dépôt lors d'une restauration), clé privée montrée une seule fois.

## 9. Questions ouvertes (décision du porteur requise)

1. Nom du produit et licence.
2. Politique de récupération du compte admin lors d'une restauration (et sauvegarde ou non du hash).
3. Authentification Git au MVP : SSH, HTTPS ou les deux.
4. Contrôles HTTP externes dans le MVP ou non.
5. Registres à supporter en premier.
6. Confirmer les choix « Proposé » du tableau (Fastify, Drizzle/Kysely, WebSocket).
