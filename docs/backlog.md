# Backlog ordonné

Dérivé de `project.md` §17–18 et de `docs/adr/0001-architecture.md`. Chaque lot est livrable et vérifiable. Les numéros « AC » renvoient aux critères d'acceptation de `project.md` §18.

## Phase 0 — Préparer
- [x] ADR d'architecture
- [x] Backlog
- [ ] Valider les questions ouvertes de l'ADR (§7)
- [ ] Contrat des opérations (états, idempotence, 409)
- [ ] Protocole agent v1 (messages typés, enrôlement, heartbeat)
- [ ] Schéma de configuration exportable (format Git v1)
- [ ] Squelette du dépôt de code, CI, lint, tests

## Phase 1 — Premier parcours complet (AC 1, 2)
0. Monorepo npm workspaces (`console`, `agent`, `web`, `shared`), TypeScript strict, lint, Vitest, CI
1. Console : serveur HTTP (Fastify), PostgreSQL, migrations avec verrou, healthcheck `/status`
2. Initialisation : secret temporaire, création atomique de l'admin, fermeture des routes publiques
3. Connexion, sessions (HttpOnly, CSRF), limitation des tentatives, changement d'identifiants
4. Chiffrement : génération et export de la clé de restauration
5. Agent : connexion sortante, heartbeat, reconnexion
6. Enrôlement du premier agent par confiance locale ; enrôlement d'un second hôte par jeton unique ; révocation
7. Inventaire Docker réel (conteneurs, groupes Compose observés)
8. `compose.yaml` de livraison (console + agent + PostgreSQL, volumes, healthchecks) et Compose agent seul
9. Frontend Vue 3 + Tailwind : squelette, routeur, écrans d'initialisation et de connexion
10. Mesure de l'empreinte mémoire de l'agent au repos

État Phase 1 (6 novembre 2026) : **terminée**, vérifiée sur Docker réel. Points ajoutés lors du solde : changement d'identifiants (révocation des autres sessions), clé de restauration age (privée montrée une fois, publique stockée), lint ESLint, CI GitHub Actions (lint, typecheck, build, tests avec PostgreSQL, audit des dépendances de production, build des images).

Mesure mémoire de l'agent au repos (Node 24 alpine, ~30 s après démarrage, 7 conteneurs sur l'hôte) : environ 33 MiB, CPU ~0 %. À remesurer sur une longue durée et avec plus de conteneurs. Console : ~49 MiB, PostgreSQL : ~38 MiB.

Limites connues : la rotation de la clé de restauration n'est pas implémentée ; l'écran d'affichage de la clé à l'initialisation est couvert par le typecheck mais pas par un test automatisé de l'interface ; la CI n'a pas encore tourné sur GitHub.

## Phase 2 — Stacks et API (AC 3 à 7, 15)

État (6 novembre 2026) : faits et vérifiés sur Docker réel : 1 (hors édition préservant les commentaires), 2 (syntaxe côté console, `docker compose config` côté agent), 3 (variables de stack), 4, 5, 6, 7 (test réel du bind mount relatif, y compris dans l'agent conteneurisé), 8 (sauf jetons API), 11 (console et son projet : noms réservés + refus des projets existants non gérés). Restent : variables d'environnement par service, jetons API, interface (liste, fiche, éditeur, diff, opérations), logs en direct, OpenAPI, démarrage d'une stack « observée » à importer.

1. Modèle stack/révision ; édition YAML préservant commentaires
2. Validation Compose avant déploiement, erreurs localisées
3. Variables de stack et de service, règles de priorité documentées
4. Fichiers associés, protection contre la sortie de dossier et les liens symboliques
5. Opérations persistantes, verrou par stack, journal expurgé
6. Déployer, redéployer, arrêter, démarrer, retour arrière ; enregistrement des digests déployés
7. Test d'intégration : bind mount d'un fichier relatif
8. API `/api/v1` stacks, variables, deploy/stop/start, operations ; jetons API ; OpenAPI
9. Logs en direct avec limites
10. Interface : liste de stacks, fiche stack, éditeur, diff, opérations
11. Auto-protection console/agent

## Phase 3 — Sauvegarde et restauration (AC 9 à 12)
1. Export d'un instantané cohérent selon le schéma v1
2. Chiffrement des secrets et classification des fichiers
3. Commit et push, file durable avec backoff, statut local vs distant
4. Détection de divergence, blocage sans force push
5. Restauration sur console vierge : staging, vérifications, aperçu, import, réenrôlement
6. Tests : panne Git, divergence, restauration complète, absence de secrets en clair

## Phase 4 — Dashboard
1. États stacks/conteneurs, healthchecks, « inconnu / dernière observation »
2. Métriques élémentaires avec rétention bornée
3. Découverte et import des stacks existantes
4. Multi-agents, filtres environnement/hôte/stack
5. Alertes : agent hors ligne, sauvegarde en échec

## Phase 5 — Images et sécurité (AC 13, 14)
1. Trivy en conteneur éphémère, cache persistant, concurrence limitée
2. Résultats, déduplication par contenu, lien image ↔ stacks
3. Scans planifiés, fraîcheur de la base, états jamais scanné / échec / sain
4. Suivi des images : même tag différent contenu, nouveaux tags selon politique
5. Abstraction registre, tests sur registre local contrôlé

## Phase 6 — Livraison
1. Durcissement erreurs et reconnexions, tests de bout en bout
2. Documentation : installation, mise à jour, dépannage, restauration, limites du MVP
3. Contrat OpenAPI publié et exemples d'appels
4. Revue sécurité (§14)
