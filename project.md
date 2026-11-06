# Projet — Console Docker, sécurité et supervision

Version du cadrage : 1.0 — 6 novembre 2026.
Nom du produit : à définir.
Langue du document et de l’interface initiale : français.

## 1. Objet du document

Ce document permet à un agent IA de commencer la conception et le développement du produit. Il rassemble les exigences exprimées et des propositions de réalisation pour les rendre exécutables.

Statuts utilisés :

- **Validé** : demandé ou confirmé par le porteur du projet.
- **Proposé** : comportement ou choix de conception recommandé dans ce document, à documenter comme hypothèse lors de l’implémentation.
- **Ouvert** : décision produit ou technique non prise.

Les exemples d’API, de schémas et de chemins sont des contrats proposés, pas une implémentation existante. Aucune stack technique, licence ou identité commerciale n’a encore été choisie. Ne pas importer automatiquement les choix d’autres projets du porteur.

## 2. Vision et objectifs

**Validé.** Construire un outil auto-hébergé réunissant :

1. La gestion des applications et stacks Docker, dans l’esprit d’une console de type Portainer.
2. Les analyses de vulnérabilités des images avec Trivy.
3. La recherche de nouvelles images et versions disponibles.
4. Un dashboard de statut des services.
5. Une API simple pour automatiser les modifications et les actions sur les stacks.
6. Une sauvegarde centralisée de la configuration dans un seul dépôt Git.

Le MVP cible Docker standalone. L’architecture doit permettre d’ajouter Docker Swarm ensuite sans reconstruire l’ensemble du produit.

L’unité principale de gestion est la **stack** : définition Compose, variables, fichiers associés, cible de déploiement et état observé. La console doit relier état opérationnel, configuration déployée, sécurité des images et mises à jour disponibles.

## 3. Décisions validées

| Sujet | Décision |
| --- | --- |
| Exécution MVP | Docker standalone |
| Évolution | Docker Swarm comme objectif ultérieur |
| Architecture | Console centrale et petit agent sur chaque hôte Docker |
| Installation initiale | Un Docker Compose lançant la console et un agent |
| Utilisateur | Un seul compte administrateur |
| Création du compte | Configuration au premier lancement |
| Édition | Création et modification des stacks depuis un éditeur Compose dès le MVP |
| Automatisation | API de création/modification, variables, déploiement/redéploiement et arrêt |
| Sécurité des images | Trivy |
| Versions d’images | Détection des nouvelles images disponibles |
| Statut | Dashboard des services |
| Git | Un seul dépôt de sauvegarde pour la configuration de l’outil et des stacks |
| Contenu Git | Compose, variables d’environnement, configuration nécessaire à la récupération |
| Récupération | Possibilité de restaurer la configuration depuis Git |

La décision Git ne signifie pas « un dépôt source par application ». Le dépôt unique sauvegarde l’état de configuration géré par l’outil. L’éditeur et l’API restent les moyens principaux de gestion.

## 4. Périmètre du MVP

### Inclus

- Installation reproductible avec Docker Compose.
- Compte administrateur unique, connexion et modification des identifiants.
- Gestion de plusieurs hôtes standalone au moyen d’agents.
- Inventaire des conteneurs et regroupement des applications Compose existantes.
- Création, import, édition et validation des stacks.
- Gestion des variables de stack et des variables d’environnement par service.
- Gestion des fichiers de configuration associés aux stacks.
- Enregistrement de révisions et distinction entre configuration enregistrée et déployée.
- Déploiement, redéploiement, démarrage et arrêt des stacks.
- Consultation des logs, états, healthchecks et métriques élémentaires.
- Scans Trivy manuels et planifiés, avec résultats exploitables.
- Recherche manuelle et planifiée des mises à jour d’images.
- Sauvegarde Git et restauration de configuration.
- API authentifiée, suivi des opérations longues et journal d’actions.

### Hors MVP

- Exécution et gestion de clusters Swarm.
- Kubernetes, construction d’images et plateforme CI complète.
- Plusieurs utilisateurs, RBAC et SSO.
- Dépôt Git distinct par stack, pull requests et déploiements automatiques sur push.
- Mise à jour automatique des applications sans action explicite.
- Sauvegarde/restauration des bases applicatives et des volumes Docker.
- Haute disponibilité de la console et déploiement distribué de ses workers.
- Remplacement complet d’une plateforme de logs ou de métriques.
- Éditeur visuel exhaustif de toutes les propriétés Compose.
- Suppression automatique de volumes ou nettoyage global Docker.

Notifications externes, terminal interactif et gestion avancée des réseaux/volumes : ouverts, non nécessaires pour terminer le MVP.

## 5. Architecture fonctionnelle

### Console centrale

Responsabilités : interface web, API, authentification, stockage de configuration, révisions, opérations, planification, résultats Trivy, suivi des images, sauvegarde Git et restauration.

### Agent par hôte

Responsabilités : communiquer avec Docker local, découvrir les ressources, collecter les états et métriques, transmettre les logs demandés, matérialiser les fichiers des stacks, valider et exécuter les opérations Compose, lancer ou piloter Trivy.

**Proposé.** L’agent initie une connexion sortante authentifiée vers la console. Aucun port entrant propre à l’agent n’est nécessaire. Le transport exact reste à choisir. Prévoir version de protocole, identifiant d’agent, capacités, heartbeat, reconnexion et révocation des accès.

Les tâches lourdes doivent être exécutées hors du traitement synchrone des requêtes web. Une file persistante simple peut suffire ; ne pas imposer un broker externe sans besoin démontré.

### Frontière pour Swarm

Le domaine exprime des opérations comme « déployer une stack » ou « obtenir l’état des composants ». Un adaptateur standalone réalise ces opérations. Un futur adaptateur Swarm utilisera ses propres notions de services, tâches et placement.

Ne pas réduire toutes les ressources futures à un identifiant de conteneur. Exposer les capacités supportées par un environnement ; une capacité absente ne doit pas être simulée.

## 6. Modèle de domaine proposé

| Entité | Informations principales |
| --- | --- |
| Administrateur | Identifiant, hash du mot de passe, dates de création et modification |
| Jeton API | Nom, empreinte, permissions éventuelles, expiration, révocation |
| Environnement | ID stable, nom, type standalone/swarm, paramètres |
| Hôte | ID stable, environnement, nom, agent, capacités, dernière présence |
| Stack | ID stable, nom, hôte cible, description, révision courante |
| Révision de stack | Compose original, variables, fichiers, auteur, date, empreinte |
| Composant | Service logique d’une stack |
| Instance | Conteneur observé d’un composant ; future tâche Swarm |
| Déploiement | Révision exacte, images effectivement utilisées, résultat, dates |
| Opération | Type, cible, demandeur, état, logs, progression et erreur |
| Image | Référence, identifiant local, digest lorsqu’il existe, plateforme |
| Scan | Image analysée, outil, version de base, date, statut, résultats |
| Sauvegarde Git | Révision locale couverte, commit, dernier push réussi, erreur |
| Événement d’audit | Action, date, demandeur, cible, résultat sans secrets |

Séparer configuration souhaitée et état observé. Un hôte hors ligne doit produire « état inconnu / dernière observation », pas « application arrêtée ».

## 7. Installation et premier lancement

### Livrable Compose

**Validé.** Fournir un fichier `docker-compose.yml` contenant au minimum les services console et agent.

**Proposé :**

- La console sert l’interface et l’API sur un seul port publié.
- L’agent accède au socket Docker local ; la console n’a pas besoin de cet accès.
- Volumes persistants séparés pour la console, le travail de l’agent et le cache Trivy.
- Réseau interne pour les échanges locaux.
- Redémarrage automatique et healthchecks des services.
- Configuration exemple sans secret de production prédéfini.
- Si une base externe est retenue, elle est incluse au Compose. Une base embarquée peut simplifier le MVP.
- Images de livraison versionnées ; ressources et architectures supportées documentées.
- Une commande `docker compose up -d` démarre l’installation, puis le navigateur permet la configuration.

L’agent doit rester léger au repos. Trivy peut être lancé comme processus ou conteneur de travail à la demande ; le choix sera documenté. Le Compose de livraison doit inclure les volumes nécessaires à cette stratégie.

### Initialisation

1. Détecter de manière atomique si le compte administrateur existe.
2. Demander identifiant et mot de passe, sans compte par défaut.
3. Initialiser le chiffrement et permettre l’export sécurisé de la clé de restauration.
4. Proposer la connexion au dépôt Git, configurable ultérieurement.
5. Associer le premier agent au moyen d’un mécanisme local de confiance, sans jeton universel codé en dur.
6. Fermer définitivement les routes publiques de création du compte une fois l’initialisation terminée.

Prévoir une protection de l’initialisation exposée sur le réseau, par exemple un secret temporaire généré localement. Deux requêtes concurrentes ne doivent pas créer deux administrateurs.

Un parcours alternatif « Restaurer depuis Git » est décrit en section 12. La politique exacte de récupération du compte administrateur est une décision à formaliser ; ne jamais rouvrir automatiquement l’inscription sur une installation configurée.

Pour les autres hôtes, fournir un Compose agent seul et un jeton d’enrôlement temporaire, à usage unique. Le serveur remet ensuite des identifiants propres à cet agent.

## 8. Gestion des stacks

### Éditeur et fichiers

- Éditer le texte YAML en conservant autant que possible sa forme, ses commentaires et ses expressions.
- Valider syntaxe et modèle Compose avant déploiement ; afficher des erreurs localisées.
- Conserver le document original et une représentation interprétée pour les vues et contrôles.
- Afficher les différences avant application et signaler une configuration modifiée mais non déployée.
- Autoriser les fichiers associés, par exemple configuration Nginx ou scripts nécessaires au démarrage.
- Empêcher les chemins sortant du dossier géré, y compris via liens symboliques.
- Les chemins absolus de bind mounts de données sur l’hôte restent explicites et doivent être vérifiés.
- Les chemins relatifs sont résolus dans un espace de travail stable sur l’hôte Docker.

Point d’implémentation obligatoire : un bind mount est interprété par le démon Docker de l’hôte. Le chemin visible dans le conteneur agent doit correspondre au bon chemin sur l’hôte, par exemple via un répertoire de travail monté au même chemin absolu. Ajouter un test d’intégration avec un fichier relatif monté dans une application réelle.

Le support des profils, fichiers Compose multiples, `build`, `include` et références externes est à préciser. Le MVP privilégie les images préconstruites. Toute fonctionnalité non supportée doit être rejetée clairement et documentée, sans application partielle silencieuse.

### Variables

Deux catégories :

- Variables d’interpolation de stack : `${IMAGE_TAG}`, `${PUBLIC_PORT}`.
- Variables d’environnement d’un service : `LOG_LEVEL`, `DATABASE_URL`.

L’interface et l’API permettent ajout, modification et suppression. Définir la priorité entre variables de stack, `.env`, fichiers `env_file` et valeurs du Compose. Ne pas hériter implicitement des variables du processus de la console ou de l’agent.

Une modification structurée de variable de service ne doit pas casser les expressions existantes ni confondre liste et mapping YAML. Une valeur sensible absente d’une réponse API ne doit pas être effacée lors d’une modification d’un autre champ.

### Cycle de vie

| Action | Sémantique proposée |
| --- | --- |
| Enregistrer | Créer une révision durable et planifier la sauvegarde Git ; ne pas déployer |
| Déployer | Valider puis appliquer une révision identifiée |
| Redéployer | Réappliquer une révision, avec politique explicite de pull et recréation |
| Arrêter | Stopper les conteneurs ; conserver fichiers, réseaux, volumes et configuration |
| Démarrer | Relancer la dernière configuration déployée ; ne pas appliquer implicitement un brouillon |
| Revenir en arrière | Appliquer explicitement une ancienne révision de configuration |

Le retour arrière de configuration ne restaure pas les données et ne garantit pas l’annulation d’une migration de base. Un ancien tag mutable peut pointer vers une autre image : enregistrer les digests réellement déployés pour expliquer et préparer une restauration fidèle.

Sérialiser les opérations incompatibles sur une même stack. En cas d’échec, conserver la sortie de commande expurgée, le résultat et l’état partiel observé. Un déploiement n’est pas une transaction atomique sur tous les conteneurs.

### Reprise des applications existantes

Découvrir les conteneurs et groupes Compose sans les modifier. Une stack découverte reste « observée » tant que son Compose et ses fichiers n’ont pas été importés puis associés explicitement. Ne pas promettre de reconstruire fidèlement le Compose original depuis les seuls conteneurs.

## 9. Supervision et logs

Dashboard global puis filtres par environnement, hôte et stack :

- Agents connectés, déconnectés et dernière communication.
- Stacks en fonctionnement, dégradées, arrêtées ou inconnues.
- Conteneurs actifs, arrêtés, en erreur et redémarrages.
- Healthchecks Docker et état « non configuré » lorsqu’il n’y en a pas.
- CPU, mémoire, réseau et métriques disponibles, avec unités et date d’observation.
- Alertes de vulnérabilités, mises à jour et sauvegarde Git en échec.

Un conteneur actif ne prouve pas que l’application répond. Les contrôles HTTP externes sont une extension proposée, distincte des healthchecks Docker ; leur inclusion au MVP reste ouverte.

Logs : sélection de stack/service/conteneur, dernières lignes, suivi en direct, horodatage, filtre textuel simple et déconnexion propre. Prévoir limites de taille, débit et clients simultanés. Ne pas rapatrier tous les logs en permanence.

Les métriques ont une rétention bornée et configurable. Une proposition initiale peut être une collecte toutes les 30 secondes et 7 jours de conservation ; ces valeurs sont des paramètres à ajuster après mesure.

## 10. Analyses Trivy

- Scanner les images utilisées, manuellement ou selon une planification configurable.
- Dédupliquer par contenu d’image et plateforme lorsqu’identifiables, pas seulement par tag.
- Refaire les analyses pour tenir compte de l’évolution de la base de vulnérabilités.
- Afficher gravité, identifiant de vulnérabilité, paquet, version installée, version corrigée si connue et liens fournis par Trivy.
- Relier une image vulnérable à toutes les stacks et instances concernées.
- Afficher date du scan, fraîcheur de la base, statut et erreurs.
- Distinguer absence de vulnérabilité connue, scan jamais effectué et scan en échec.
- Limiter la concurrence, la durée et l’utilisation des ressources ; cache persistant.
- Ne pas bloquer par défaut un déploiement sur la gravité d’un résultat.

Le scan des secrets, des fichiers IaC et du système hôte n’est pas requis au MVP. Le stockage des sorties brutes doit être borné et expurgé si nécessaire.

## 11. Recherche de nouvelles images

Deux résultats distincts :

1. **Même tag, contenu différent** : comparer le contenu actuellement déployé avec celui proposé par le registre pour la plateforme cible.
2. **Nouveaux tags candidats** : rechercher des versions correspondant à une politique de suivi.

Politique proposée par composant : même tag uniquement, correctifs, mineures, majeures ou motif de tags. Ne pas supposer que tous les tags suivent SemVer ni qu’un ordre alphabétique donne la dernière version. Exclure les préversions par défaut lorsqu’elles sont identifiables. Pour les tags non interprétables, afficher des candidats et l’incertitude.

Gérer images épinglées par digest, images locales sans registre, images privées, multiarchitecture, authentification, pagination et limites de requêtes. Un échec de registre donne un statut inconnu/erreur et conserve la dernière observation datée.

Périmètre initial des registres : à choisir et documenter. Prévoir une abstraction et des tests sur un registre contrôlé. Ne pas revendiquer la compatibilité universelle dès le MVP.

Aucun téléchargement massif ni redéploiement automatique lors d’une simple vérification. L’utilisateur choisit la mise à jour et déclenche l’opération.

## 12. Dépôt Git unique de sauvegarde

### Principe

**Validé.** Un seul dépôt conserve la configuration de toute l’installation, notamment les Compose et variables de toutes les stacks. Il est distinct du dépôt contenant le code source de ce produit.

**Proposé.** Le stockage local de la console est l’autorité opérationnelle. Git est une copie versionnée de sauvegarde. Le système ne surveille pas Git pour déployer automatiquement. Les modifications distantes sont intégrées par une action explicite de récupération/restauration.

### Organisation proposée

| Chemin | Contenu |
| --- | --- |
| `manifest.yaml` | Version du format, ID d’installation, révision de configuration |
| `settings/config.yaml` | Paramètres généraux non sensibles |
| `environments/<id>.yaml` | Environnements et hôtes logiques |
| `stacks/<id>/stack.yaml` | Nom, cible, règles de suivi et métadonnées |
| `stacks/<id>/compose.yaml` | Définition Compose |
| `stacks/<id>/variables.yaml` | Variables non sensibles |
| `stacks/<id>/files/` | Fichiers associés non sensibles |
| `secrets/` | Valeurs et fichiers sensibles sous forme chiffrée |

Utiliser des identifiants stables dans les chemins, pas des noms modifiables. Un schéma versionné et des migrations rendent les sauvegardes durables.

### Synchronisation

- Chaque changement de configuration crée un travail de sauvegarde durable ; regroupement possible des changements rapprochés.
- Exporter un instantané cohérent, créer un commit puis pousser sur la branche configurée.
- Journaliser auteur logique, action et révision couverte sans inclure de secret.
- Afficher dernier commit local, dernier push réussi, révision couverte et modifications en attente.
- Si Git est indisponible, continuer à gérer les stacks et réessayer avec temporisation progressive.
- Ne pas déclarer une sauvegarde distante réussie sur le seul succès du commit local.
- En cas de divergence distante, bloquer la synchronisation et présenter le problème ; aucun force push automatique.
- Préserver les fichiers étrangers éventuels ; ne gérer que le périmètre configuré du dépôt.

Authentification Git par SSH et/ou HTTPS à préciser. Vérifier les clés d’hôte SSH et les certificats TLS. Les identifiants Git et la clé de déchiffrement doivent pouvoir être fournis hors sauvegarde pour amorcer une restauration.

### Secrets

Ne jamais écrire les secrets en clair dans Git, les diffs, les logs d’opération ou les réponses ordinaires de l’API. Utiliser un mécanisme de chiffrement authentifié éprouvé ; ne pas inventer d’algorithme.

La configuration sensible peut apparaître dans des variables, des fichiers associés ou directement dans un Compose. Prévoir une classification explicite des fichiers et la possibilité de chiffrer le Compose complet. Un scanner de motifs ne garantit pas l’absence de secret : documenter cette limite et ne pas exporter aveuglément tous les fichiers en clair.

La clé de restauration est exportable et conservée séparément du dépôt. Sans elle, les secrets chiffrés ne sont pas récupérables. Documenter rotation et migration ; ne pas laisser entendre qu’un retrait Git supprime un secret déjà présent dans l’historique.

### Restauration

1. Sur une console vierge, choisir la restauration.
2. Fournir dépôt, branche, accès Git et clé de restauration.
3. Récupérer dans un espace temporaire puis vérifier format, chemins, intégrité et compatibilité.
4. Afficher les stacks, environnements et paramètres à récupérer.
5. Créer ou rétablir l’accès administrateur selon une procédure locale sécurisée.
6. Importer la configuration de manière cohérente et réassocier les agents.
7. Réenrôler les agents si leurs identifiants ne sont pas restaurés ; ne pas faire confiance à un simple ID retrouvé dans Git.
8. Vérifier chemins et ressources disponibles sur les hôtes.
9. Laisser l’utilisateur déclencher les déploiements.

Ne pas lancer ou arrêter de conteneurs automatiquement lors d’une restauration. Sur une installation existante, afficher les conflits et exiger un choix explicite de remplacement, sans écrasement silencieux.

Ne pas sauvegarder dans Git : volumes applicatifs, base opérationnelle complète, métriques, caches Trivy, logs, sessions et jetons actifs. Les préférences du compte peuvent être sauvegardées ; la politique du hash de mot de passe reste à décider. Une restauration de configuration ne doit pas réactiver des sessions ou jetons révoqués.

## 13. API proposée

Préfixe versionné `/api/v1`. JSON, documentation OpenAPI, erreurs structurées, dates UTC ISO 8601 et identifiants stables.

| Méthode et route | Usage |
| --- | --- |
| `GET /status` | État public minimal du processus, sans détail sensible |
| `GET /api/v1/environments` | Lister les environnements |
| `GET /api/v1/hosts` | Lister les hôtes et leur présence |
| `POST /api/v1/agents/enrollment-tokens` | Préparer un enrôlement |
| `POST /api/v1/stacks` | Créer une stack |
| `GET /api/v1/stacks` | Lister avec état et révisions |
| `GET /api/v1/stacks/{id}` | Consulter une stack |
| `PUT /api/v1/stacks/{id}/compose` | Remplacer le Compose |
| `PATCH /api/v1/stacks/{id}/variables` | Modifier les variables de stack |
| `PATCH /api/v1/stacks/{id}/services/{service}/environment` | Modifier les variables d’un service |
| `PUT /api/v1/stacks/{id}/files/{path}` | Enregistrer un fichier associé |
| `GET /api/v1/stacks/{id}/revisions` | Consulter les révisions |
| `POST /api/v1/stacks/{id}/deploy` | Déployer ou redéployer |
| `POST /api/v1/stacks/{id}/stop` | Arrêter |
| `POST /api/v1/stacks/{id}/start` | Démarrer |
| `GET /api/v1/operations/{id}` | Suivre une opération |
| `POST /api/v1/stacks/{id}/scans` | Demander un scan |
| `POST /api/v1/stacks/{id}/image-checks` | Vérifier les images |
| `GET /api/v1/backup/status` | Consulter la sauvegarde Git |
| `POST /api/v1/backup/sync` | Demander une synchronisation |
| `POST /api/v1/api-tokens` | Créer un jeton API |
| `DELETE /api/v1/api-tokens/{id}` | Révoquer un jeton |

Prévoir aussi les routes de session, résultats de scans, paramètres, restauration et streaming. Le contrat complet sera produit pendant la première phase.

Exemple de modification :

```json
{
  "expectedRevision": 7,
  "set": { "IMAGE_TAG": "1.4.2", "LOG_LEVEL": "info" },
  "unset": ["OLD_VARIABLE"]
}
```

La réponse indique la nouvelle révision et le statut de sauvegarde, sans prétendre qu’un push asynchrone a déjà réussi.

Exemple de déploiement :

```json
{
  "revision": 8,
  "pullImages": true,
  "forceRecreate": false
}
```

Réponse `202 Accepted` avec `operationId` et URL de suivi. Une opération capture la révision demandée ; elle ne lit pas un brouillon qui évolue pendant son exécution.

États proposés : `pending`, `running`, `succeeded`, `failed`, `unknown`. Distinguer succès de la commande Compose et état de santé observé après exécution. Après une rupture de connexion, ne pas relancer aveuglément une commande dont le résultat est inconnu.

Prévoir une clé d’idempotence pour les commandes, un contrôle de concurrence sur les modifications et un code `409` en cas de conflit. Définir précisément les délais et conditions de succès.

## 14. Authentification et sécurité d’exécution

- Mot de passe stocké sous forme de hash adapté, jamais de chiffrement réversible.
- Sessions protégées, cookies HttpOnly et politique Secure compatible avec le mode TLS documenté.
- Protection CSRF des opérations authentifiées par cookie ; CORS restrictif.
- Jetons API aléatoires, affichés une seule fois, stockés par empreinte, révocables.
- Limitation des tentatives de connexion et des requêtes coûteuses.
- Communications agent-console authentifiées et chiffrées hors réseau local de confiance.
- Aucun endpoint générique permettant d’exécuter une commande shell arbitraire.
- Appels de processus avec arguments structurés, délais et sorties bornées.
- Autoriser uniquement les actions typées du protocole ; rejeter les demandes expirées ou rejouées.
- Contrôle des chemins, archives et liens lors des imports et restaurations.
- Ne pas exposer le socket Docker sur un port public.
- Documenter que le contrôle du démon Docker donne des capacités très élevées sur l’hôte, même avec un montage du socket présenté comme lecture seule.

Les secrets doivent être transmis à l’agent uniquement lorsque nécessaire et ne pas rester dans des fichiers temporaires accessibles. Les fichiers d’exécution requis peuvent contenir des secrets : permissions restrictives, nettoyage et documentation des limites d’accès hôte.

Le produit gère potentiellement sa propre stack. Pour le MVP, protéger la console et son agent contre leur arrêt/redéploiement depuis leur propre interface, ou proposer un mécanisme explicitement testé. Un remplacement automatique de l’outil lui-même n’est pas requis.

## 15. Interface proposée

Navigation principale : Dashboard, Environnements/Hôtes, Stacks, Images/Sécurité, Opérations, Sauvegarde Git et Paramètres.

Fiche stack : Vue d’ensemble, Compose, Variables, Fichiers, Conteneurs, Logs, Sécurité, Mises à jour et Historique.

Actions longues visibles avec statut et possibilité de consulter le résultat après rechargement de page. Signaler clairement : agent hors ligne, modifications non déployées, sauvegarde en attente, scan périmé et vérification d’image en erreur.

L’interface utilise les mêmes services applicatifs que l’API. Éviter une logique métier réservée au frontend. Prévoir accessibilité clavier, messages d’erreur utiles et mise en page utilisable sur ordinateur portable.

## 16. Choix techniques à effectuer

Le porteur n’a pas arrêté les langages ou frameworks. L’agent commence par proposer et documenter un ensemble cohérent :

| Décision | Critères |
| --- | --- |
| Backend console | Maintenabilité, API, tâches asynchrones, migrations |
| Frontend | Édition YAML, affichage des logs, simplicité de développement |
| Agent | Faible empreinte, accès Docker, exécution fiable de Compose/Trivy |
| Stockage | Configuration, opérations durables, métriques bornées, exploitation simple |
| Transport agent | Sortant, reconnexion, streaming, authentification et compatibilité |
| Chiffrement | Bibliothèque éprouvée, export de clé, sauvegarde et restauration testables |
| Registres initiaux | Authentification, digests, tags et limites réelles |
| Bibliothèques Docker/Compose | Compatibilité avec les versions retenues |

Choisir des versions stables supportées au moment de l’implémentation et vérifier les documentations officielles. Ne pas choisir des numéros de version sur la seule base de ce document. Un monolithe modulaire pour la console et un agent séparé suffisent ; éviter les microservices prématurés.

La licence, le nom, l’identité visuelle, les canaux de notifications et le support Windows restent ouverts. Cible proposée de départ : hôtes Linux avec Docker Engine et Compose compatible, versions minimales à documenter.

## 17. Plan de réalisation pour l’agent IA

### Phase 0 — Préparer

- Lire ce document et les éventuelles instructions du dépôt de code.
- Inventorier l’existant avant de générer des fichiers ou remplacer des choix.
- Créer une courte décision d’architecture avec hypothèses et choix techniques.
- Définir schéma de configuration exportable, contrat d’opérations et protocole agent.
- Transformer les exigences en backlog ordonné et critères vérifiables.

### Phase 1 — Premier parcours complet

Livrer le Compose console + agent, persistance, création du compte unique, connexion, association du premier hôte et inventaire Docker réel.

### Phase 2 — Gestion des stacks et API

Livrer éditeur, variables, fichiers, validation, révisions et parcours API : créer une stack simple, la déployer, modifier une variable, redéployer et l’arrêter. Ajouter logs et opérations persistantes.

### Phase 3 — Sauvegarde et restauration

Livrer dépôt unique, chiffrement, commit/push, reprise après indisponibilité et restauration sur une console vierge. Tester ce parcours avant d’accumuler des fonctions annexes.

### Phase 4 — Dashboard

États, healthchecks, métriques élémentaires, découverte des stacks existantes, gestion de plusieurs agents et affichage des états inconnus.

### Phase 5 — Images et sécurité

Trivy, historique borné des résultats, suivi des images par digest et recherche de tags selon la politique configurée.

### Phase 6 — Livraison

Durcir les erreurs et reconnexions, réaliser les tests de bout en bout, documenter installation/mise à jour/restauration, publier le contrat OpenAPI et fournir les exemples API.

Après chaque phase, fournir ce qui fonctionne, comment le vérifier et les limites restantes. Avancer sur les choix réversibles ; demander une clarification uniquement lorsqu’une décision change réellement le périmètre ou les garanties.

## 18. Validation et critères d’acceptation

Le MVP est terminé lorsque les parcours suivants fonctionnent réellement :

1. Une installation vierge démarre par Compose, conserve ses données après redémarrage et permet de créer exactement un administrateur.
2. L’agent local apparaît et un second hôte peut être enrôlé puis révoqué.
3. Une stack avec deux services, variables et fichier relatif associé peut être créée, validée et déployée depuis l’interface.
4. L’API modifie une variable, renvoie une nouvelle révision puis déploie exactement cette révision.
5. Arrêter une stack conserve sa configuration et les données de son volume ; la redémarrer restaure son exécution.
6. Une configuration invalide échoue avant modification des conteneurs.
7. Les logs sont consultables en direct et les opérations restent consultables après redémarrage de la console.
8. La perte d’un agent ne transforme pas les états en faux succès ou faux arrêts ; la reconnexion ne rejoue pas arbitrairement les actions.
9. Les modifications sont poussées dans un dépôt unique ; une panne Git affiche des changements en attente, puis la sauvegarde reprend.
10. Une divergence Git ne provoque pas de force push ou d’écrasement automatique.
11. Une console vierge récupère les Compose, variables, fichiers et paramètres depuis Git avec la clé prévue, sans déploiement automatique.
12. Les secrets de test ne se retrouvent pas en clair dans le dépôt, les sorties d’opérations ou les réponses habituelles.
13. Un scan Trivy réel affiche ses résultats, son erreur éventuelle et les stacks concernées ; un scan raté ne devient pas un résultat sain.
14. Un changement d’image derrière un tag est détecté sur un registre contrôlé, sans déclencher de déploiement.
15. Des jetons API peuvent être créés, utilisés puis révoqués ; les accès non authentifiés sont refusés.

Tests nécessaires : logique de variables et révisions, chemins et chiffrement, concurrence et idempotence, intégration Docker/Compose réelle, Git local puis distant de test, restauration complète, API authentifiée et parcours UI principal. Simuler les erreurs de réseau et délais. Utiliser des ressources Docker isolées, identifiées et nettoyées sans toucher aux applications de l’utilisateur.

La compatibilité Swarm n’a pas à être testée comme fonction disponible au MVP ; vérifier seulement que les dépendances standalone restent derrière leurs interfaces.

## 19. Livrables attendus du développement

- Code source console, frontend et agent.
- `docker-compose.yml` de livraison et exemple de configuration.
- Compose agent seul pour les hôtes supplémentaires.
- Instructions de développement, installation, mise à jour et dépannage.
- Contrat OpenAPI et exemples d’appels automatisés.
- Schéma versionné de sauvegarde Git et documentation des migrations.
- Procédure de restauration incluant clés, agents et limites concernant les données.
- Tests automatisés pertinents et procédure de validation réelle.
- Décisions d’architecture et liste explicite des limites du MVP.

## 20. Priorités de conception

Favoriser d’abord un parcours réel et reproductible : installer, créer une stack, la modifier par API, déployer, sauvegarder puis restaurer. Maintenir une séparation nette entre configuration enregistrée, sauvegarde distante et état réellement exécuté. Ajouter la supervision et les analyses autour de ce socle, avec des erreurs visibles et des opérations traçables.
