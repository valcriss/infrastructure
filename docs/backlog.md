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
8. `docker-compose.yml` de livraison (console + agent + PostgreSQL, volumes, healthchecks) et Compose agent seul
9. Frontend Vue 3 + Tailwind : squelette, routeur, écrans d'initialisation et de connexion
10. Mesure de l'empreinte mémoire de l'agent au repos

État Phase 1 (6 novembre 2026) : **terminée**, vérifiée sur Docker réel. Points ajoutés lors du solde : changement d'identifiants (révocation des autres sessions), clé de restauration age (privée montrée une fois, publique stockée), lint ESLint, CI GitHub Actions (lint, typecheck, build, tests avec PostgreSQL, audit des dépendances de production, build des images).

Mesure mémoire de l'agent au repos (Node 24 alpine, ~30 s après démarrage, 7 conteneurs sur l'hôte) : environ 33 MiB, CPU ~0 %. À remesurer sur une longue durée et avec plus de conteneurs. Console : ~49 MiB, PostgreSQL : ~38 MiB.

Limites connues : la rotation de la clé de restauration n'est pas implémentée ; l'écran d'affichage de la clé à l'initialisation est couvert par le typecheck mais pas par un test automatisé de l'interface ; la CI n'a pas encore tourné sur GitHub.

## Phase 2 — Stacks et API (AC 3 à 7, 15)

État (6 novembre 2026) : faits et vérifiés sur Docker réel : 1 (hors édition préservant les commentaires), 2 (syntaxe côté console, `docker compose config` côté agent), 3 (variables de stack), 4, 5, 6, 7 (test réel du bind mount relatif, y compris dans l'agent conteneurisé), 8 (sauf jetons API), 11 (console et son projet : noms réservés + refus des projets existants non gérés). Ajoutés ensuite : variables d'environnement par service (YAML préservé) et jetons API (AC 4 et 15, vérifiés sur Docker réel). Ajoutés enfin (6 novembre 2026) : logs en direct (SSE, flux bornés), interface complète (liste, création, fiche : vue d'ensemble, éditeur Compose CodeMirror avec différences, variables avec valeurs sensibles masquées, fichiers, logs, historique avec différences et déploiement d'une révision, opérations). Ajoutés pour clore la phase : contrat OpenAPI 3.1 (généré depuis les schémas Zod, validé, test de non-dérive) et import des projets Compose observés (reprise explicite, prévisualisation, aucun service supprimé). **Phase 2 terminée.** Reste hors périmètre : test E2E automatisé de l'interface (Playwright).

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

État (6 novembre 2026) : **terminée**, vérifiée de bout en bout sur un serveur Gitea en HTTPS (jeton, autorité de certification interne) : configuration par l'assistant, push automatique regroupé, absence de secret en clair dans le dépôt et son historique, destruction complète de la console puis restauration depuis le même dépôt avec la clé de restauration (même installation, même clé, aucun conteneur lancé, historique poursuivi en avance rapide). Décisions du porteur appliquées : authentification Git HTTPS + jeton ; compte administrateur créé par l'assistant (secret d'initialisation) et jamais sauvegardé ; dépôt configuré dans l'assistant (URL, identifiant, jeton). Reste hors périmètre : rotation de la clé de restauration, historique des révisions dans Git, test avec d'autres hébergeurs que Gitea.

1. Export d'un instantané cohérent selon le schéma v1
2. Chiffrement des secrets et classification des fichiers
3. Commit et push, file durable avec backoff, statut local vs distant
4. Détection de divergence, blocage sans force push
5. Restauration sur console vierge : staging, vérifications, aperçu, import, réenrôlement
6. Tests : panne Git, divergence, restauration complète, absence de secrets en clair

## Phase 4 — Dashboard

État (6 novembre 2026) : **terminée**. Décisions du porteur : pas de contrôles HTTP externes pour le moment ; collecte des métriques toutes les 30 s, rétention 7 jours (paramétrables). Fait : états des stacks avec la sémantique « inconnu / dernière observation » (hôte hors ligne ou observation périmée ≠ arrêté), healthchecks Docker (non configuré ≠ en échec), redémarrages, métriques CPU / mémoire / réseau avec purge, tableau de bord filtrable par hôte et par stack, alertes (agent hors ligne, stack dégradée, healthcheck, redémarrages, sauvegarde Git, opération inconnue), onglet Métriques. Vérifié sur Docker réel : une boucle active mesurée à ~100 % de CPU, un conteneur en échec (code 3) → stack dégradée avec la raison, agent arrêté → stack « inconnue » alors que les conteneurs tournent encore, retour à la normale à la reconnexion. Reste hors périmètre : métriques de l'hôte, notifications, historique des alertes, alertes de vulnérabilités et de mises à jour (Phase 5).
1. États stacks/conteneurs, healthchecks, « inconnu / dernière observation »
2. Métriques élémentaires avec rétention bornée
3. Découverte et import des stacks existantes
4. Multi-agents, filtres environnement/hôte/stack
5. Alertes : agent hors ligne, sauvegarde en échec

## Phase 5 — Images et sécurité (AC 13, 14)

État (6 novembre 2026) : **terminée**. Décisions du porteur : registres privés pris en charge en plus de Docker Hub et GHCR. Vérifié sur Docker réel : Trivy 0.76.1 en conteneur éphémère (alpine:3.12 → 1 critique ; image d'un registre privé authentifié → 10 vulnérabilités), contrôle réel de Docker Hub, registre privé en Basic (identifiants refusés, registre injoignable → dernière observation conservée), tag republié détecté, faux changement dû au réempaquetage containerd écarté par comparaison des couches. Hors périmètre : mise à jour automatique, blocage de déploiement, notifications, registres inaccessibles depuis la console.
1. Trivy en conteneur éphémère, cache persistant, concurrence limitée
2. Résultats, déduplication par contenu, lien image ↔ stacks
3. Scans planifiés, fraîcheur de la base, états jamais scanné / échec / sain
4. Suivi des images : même tag différent contenu, nouveaux tags selon politique
5. Abstraction registre, tests sur registre local contrôlé

### Registre d'images privé — lot A (11 novembre 2026)

Premier lot de la remédiation des images (`remediation.md`) : le registre d'abord. Fait : application `registry:3` générée et déployée comme une stack gérée derrière Traefik (onglet Paramètres → Registry), stacks « gérées » protégées contre l'édition manuelle (migration 023, `423 stack_managed`, détachement), compte unique avec mot de passe généré (bcrypt dans `auth/htpasswd`, secret chiffré dans les registres d'images), renouvellement, affichage des identifiants (administrateur, audité), test d'accès (DNS, certificat, 401 / 200). Vérifié sur Docker réel (`registry:3.0.0`) : Compose généré valide, accès anonyme et mauvais mot de passe refusés (401), `docker login`, push et pull réussis. Non vérifié de bout en bout : la chaîne Traefik + Let's Encrypt avec un vrai nom de domaine public. Reste : liste des images, rétention et nettoyage, séparation lecture / publication, verrouillage de l'application Traefik sur le même principe, puis le moteur de correctifs (Copa) et le parcours de remédiation.

### Remédiation des images — lot D5, préparation planifiée des correctifs (12 novembre 2026)

Fait : préparation automatique des correctifs (désactivée par défaut) pour les images d'applications gérées devenues éligibles — passage toutes les 10 minutes, une fois par contenu d'image, plafond par 24 h, exclusions, pause de 24 h après trois échecs consécutifs, auteur « planification » (migration 028 : relecture), indicateur « à relire » sur la page Images, marquage « relu », passage immédiat administrateur, routes `/api/v1/settings/remediation`, `/remediations/to-review` et `/remediations/:id/review`. Jamais d'application à une stack ni de déploiement. Reste : notifications externes (e-mail, webhook : le projet n'en a pas encore), indicateur sur le tableau de bord, correctifs des images observées, multi-plateforme.

### Remédiation des images — lot D2, annulation d'un correctif en cours (12 novembre 2026)

Fait : message `patch_cancel` (capacité `image.patch.cancel`), annulation par signal à chaque étape côté agent (processus tué, conteneurs éphémères supprimés, y compris pour un correctif encore en file), résultat `cancelled` ; côté console, l'arrêt est demandé puis confirmé (jamais « annulé » sans confirmation, « indéterminé » après deux minutes, confirmation tardive acceptée, résultat valable si le correctif se termine avant), migration 027, bouton « Arrêter le correctif », test de bout en bout de l'annulation dans `patch-e2e`. Reste : images composées, multi-plateforme, rétention automatique du registre.

### Remédiation des images — lot D3, images paramétrées par variable (12 novembre 2026)

Fait : quand une variable porte toute la référence d'image (`${NOM}`, `${NOM:-défaut}`, `${NOM-défaut}`, `$NOM`), « Utiliser l'image corrigée » change la variable de la stack dans une nouvelle révision non déployée, sans toucher au Compose (`editServiceImageVariable`, mode « variable » des cibles, aperçu des variables avec valeurs sensibles masquées). Refus motivés : variable utilisée ailleurs, sensible, image composée de plusieurs variables, formes `:?` / `:+`. Reste : images composées (`${REG}/app:${TAG}`), fichier `.env` externe, annulation d'un correctif en cours, multi-plateforme.

### Remédiation des images — lot D1, images du registre et nettoyage prudent (12 novembre 2026)

Fait : liste des images du registre (API du registre : dépôts, tags, digests, taille) avec leurs usages (révisions courante / déployée / anciennes, conteneurs en cours, correctifs actifs), suppression manuelle par digest réservée aux administrateurs (dépôts `patched/…` seulement, jamais une image utilisée, confirmation pour les anciennes révisions, audit), correctif marqué « image supprimée » (migration 026), commande de ramasse-miettes documentée et vérifiée sur `registry:3.0.0`, client du registre testé contre un vrai registre. Reste : rétention automatique, ramasse-miettes lancé par la console, comptes lecture / publication, annulation d'un correctif en cours, images paramétrées par variable, multi-plateforme.

### Remédiation des images — lot C2, interface et révision de stack (12 novembre 2026)

Fait : dialogue « Corriger l'image » (page Images et onglet Sécurité d'une application) avec éligibilité et motifs de refus, suivi en direct, historique, bilan avant / après, provenance ; « Utiliser l'image corrigée » = nouvelle révision NON déployée qui ne change que la référence d'image (éditeur `editServiceImageRef`, migration 025 pour le lien correctif → application, routes `stack-targets`, `stack-revision/preview` et `stack-revision`), strict sur l'identité de l'image, confirmation obligatoire pour un correctif partiel, applications générées et console refusées. Vérifié dans le navigateur sur une console de développement alimentée par un faux agent (étapes en direct, refus fin de vie, service paramétré refusé, aperçu du Compose, révision créée sans déploiement, confirmation du verdict partiel). Reste : nettoyage et liste des images du registre, comptes lecture / publication, annulation d'un correctif en cours, images paramétrées par variable, multi-plateforme, test de téléchargement depuis un second hôte.

### Remédiation des images — lot C1, moteur de correctifs (11 novembre 2026)

Moteur de bout en bout, sans interface (ADR 0002). Fait : image `patcher` (Copa seul, somme SHA-256 vérifiée, CI et releases), runner de l'agent (BuildKit rootless éphémère, Copa, Trivy distant, comparaison de configuration sans valeurs, paquets modifiés), protocole `patch` / `patch_progress` / `patch_result`, table `remediation_jobs` (migration 024), verdict calculé par la console à partir des deux scans, éligibilité décidée par Trivy (Alpine et Debian, fin de vie refusée), API et OpenAPI. Vérifié sur Docker réel : parcours complet sur `alpine:3.22.0` en une dizaine de secondes (copie dans un registre local, scan, correctif, rescan par digest, verdict « validé », rien de résiduel). Reste : interface (parcours Images, comparaison avant / après), proposition de révision de stack, comptes lecture / publication et nettoyage du registre, annulation d'un correctif en cours, multi-plateforme.

## Phase 6 — Livraison

État (6 novembre 2026) : **en cours**. Fait : revue de sécurité du §14 (écarts corrigés : demandes rejouées ou expirées refusées par l'agent, protection de la stack de la console et de l'agent contre leur propre interface ; section « Sécurité » du README). Reste : durcissement et tests de bout en bout, guide d'exploitation, exemples d'appels API.

Refonte de l'interface (7 novembre 2026, à la demande du porteur) : cadre (en-tête, menu latéral, thème clair / sombre), tableau de bord avec graphiques animés (ECharts), page Applications en tuiles (gérées / observées), page Images, page Statut, utilisation des machines hôtes mesurée par l'agent. Vérifié sur Docker réel (clair, sombre, mobile 375 px).
1. Durcissement erreurs et reconnexions, tests de bout en bout
2. Documentation : installation, mise à jour, dépannage, restauration, limites du MVP
3. Contrat OpenAPI publié et exemples d'appels
4. Revue sécurité (§14)
