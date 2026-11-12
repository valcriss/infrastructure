# ADR 0002 — Remédiation des images : moteur de correctifs et registre

Statut : **Proposé**, appuyé sur un spike réalisé le 11 novembre 2026 — le moteur est validé sur Alpine et Debian, les points « Non vérifié » restent à traiter avant de coder.
Référence : `remediation.md` (spécification fonctionnelle), §5, §6, §14 et §16 (décisions n° 3 et n° 6) ; lot A du backlog (registre privé, livré).

## 1. Contexte

La remédiation prépare, construit, vérifie et publie des images corrigées à partir d'images déjà surveillées, sans jamais modifier une image source ni un conteneur en fonctionnement, et sans déploiement automatique. Deux inconnues bloquaient la conception : le moteur de correctifs (Project Copacetic, « Copa », avec BuildKit) pouvait-il produire une image réellement corrigée, et avec quelle topologie ? Le registre privé, prérequis du reste, est livré (lot A).

## 2. Spike : méthode

Banc jetable sur Docker 29.9.2 (magasin d'images containerd), hors du dépôt. Versions : Copa 0.15.0 (archive vérifiée par somme SHA-256), Trivy 0.76.1 (celle de l'agent), BuildKit 0.35.0, `registry:3.0.0`. Rapport Trivy produit avec `--pkg-types os --scanners vuln --ignore-unfixed --format json`, comme l'exige Copa.

Deux topologies comparées :

- **A — Docker intégré** : `copa patch --addr docker://`, socket Docker monté dans le runner, image locale.
- **B — BuildKit dédié** : conteneur `moby/buildkit` (`--privileged`, écoute TCP), Copa joint `tcp://…`, image lue et publiée dans une registry (`--push`), aucun socket Docker dans le runner.

## 3. Résultats

| Image | Corrigeables avant | Après (même scan) | Nouvelles | Patch |
| --- | --- | --- | --- | --- |
| `alpine:3.22.0` | 57 CVE (112 constats : 2 critiques, 22 élevées) | 0 | 0 | 3,6 s (B), 5,5 s (A) |
| `debian:bookworm-20240110-slim` | 95 CVE | 0 | 0 | 25 s |
| `alpine:3.12` (fin de vie) | 1 critique | 0 | 0 | 2,4 s |

- Le parcours complet est reproductible : image source en registry → scan → patch → push → rescan **par digest** → pull par digest depuis l'hôte → exécution. Le digest scanné est celui publié.
- Debian : le scan complet passe de 195 à 100 CVE ; les 100 restantes n'ont pas de correctif publié.
- Configuration d'image préservée (`Env`, `Cmd`, `WorkingDir`) ; Copa ajoute un label `BaseImage`.
- Copa produit un document **OpenVEX** (57 déclarations sur Alpine) : provenance exploitable pour le rapport.
- BuildKit au repos : environ 195 Mo de mémoire ; images : 355 Mo (BuildKit), 198 Mo (mon runner d'essai, allégeable).

## 4. Décisions

### 4.1 Topologie : BuildKit dédié, aucun socket Docker dans le runner (topologie B)

Répond à la décision n° 3 de `remediation.md` §16.

- Le mode `--addr docker://` est **écarté** : il exige le client `docker` dans le runner et le socket du démon, c'est-à-dire un accès équivalent à root sur l'hôte pour un composant qui traite des images non fiables.
- Le moteur travaille **registre → registre**. Il dépend donc d'un registre accessible à BuildKit et à l'agent : le registre privé du lot A est un prérequis. Une image qui n'existe qu'en local est d'abord poussée dans ce registre (poussée d'une copie, la source reste intacte).
- BuildKit est un conteneur à privilèges élevés (`--privileged` dans le spike). Il n'est lancé que pour un patch, avec ressources plafonnées, sur un réseau dédié sans autre service, et arrêté ensuite. La variante **rootless** a été validée (mêmes résultats) mais ne démarre pas sur les hôtes qui interdisent les espaces de noms utilisateur non privilégiés (Ubuntu 23.10+ par défaut, constaté sur les runners GitHub) : l'agent le dit clairement et propose soit le réglage `kernel.apparmor_restrict_unprivileged_userns=0`, soit un repli privilégié **explicite** (`BUILDKIT_PRIVILEGED=1`), jamais automatique. Même en rootless, runc ne peut monter `/proc` pour les étapes de construction que si les chemins de `/proc` ne sont pas masqués : le conteneur BuildKit reçoit donc `seccomp`, `apparmor` et `systempaths` « unconfined » (comme dans la documentation de BuildKit), tout en restant sans `--privileged`, éphémère et plafonné.
- Copa, BuildKit et Trivy sont **épinglés par version et par digest**, avec vérification de somme de l'archive Copa au build de l'image du runner.
- Les arguments passés à Copa sont construits par l'agent à partir de champs validés (référence d'image par digest, plateforme, tag cible) ; jamais de ligne de commande issue de l'API.

### 4.2 Règle de verdict : le rescan décide, jamais le moteur

Répond à la décision n° 6 de `remediation.md` §16.

- Le résumé de Copa (« N patched ») compte des paquets et réussit même quand il y a peu à faire : il n'est **pas** un verdict.
- Le verdict (`validé / partiel / refusé / échec`) vient d'un **nouveau scan Trivy de l'image produite, lue par son digest dans le registre**, avec les mêmes options que le scan de référence (`--pkg-types`, `--ignore-unfixed`, gravités). Une comparaison à options différentes produit de fausses « nouvelles CVE » (observé dans le spike).
- Le bilan sépare, comme `remediation.md` §4.1 : CVE uniques corrigées / restantes avec correctif / restantes sans correctif (« non corrigeables actuellement ») / nouvelles / acceptées. Les constats par paquet ne sont pas présentés comme des CVE.
- Le bilan mentionne la base de vulnérabilités de chaque scan (date et version) : une différence entre les deux fausse la comparaison.
- Un scan favorable atteste la sécurité de l'image, pas le bon fonctionnement de l'application ; le MVP affiche cette limite et ne fait que des contrôles structurels (configuration d'image inchangée sauf ajouts autorisés, plateforme, digest).

### 4.3 Politique `os_safe` : à reformuler

Copa met les paquets concernés **à la dernière version disponible** dans les dépôts, pas à la version minimale corrigée (spike : zlib 1.3.1 → 1.4, libcrypto 3.5.0 → 3.5.9). La politique ne peut donc pas promettre « changements minimaux ». Elle garantit : pas de changement de version majeure de la distribution, configuration d'image préservée, et **liste complète des paquets modifiés (ancienne → nouvelle version) affichée avant toute publication**. Un changement de version majeure d'un paquet (saut de numéro majeur) est signalé dans le rapport.

### 4.4 Éligibilité : décidée par Trivy, pas par Copa

Copa a patché une Alpine 3.12 en fin de vie sans erreur (code de sortie 0) ; l'option `--exit-on-eol` n'a rien bloqué dans le spike. L'éligibilité (distribution prise en charge, `EOSL`, architecture) est donc décidée par la console d'après les métadonnées du scan Trivy, **avant** de lancer le moteur. Une image en fin de vie est signalée « non applicable » avec le motif ; patcher une distribution EOL reste possible seulement par exception explicite d'un administrateur, avec avertissement.

### 4.5 Registre

Le registre du lot A est retenu tel quel : application `registry:3` gérée derrière Traefik, compte unique, authentification native. Le moteur y publie par digest. La séparation des comptes lecture / publication, la liste des images, la rétention et le nettoyage restent à faire (lot suivant) avant d'y publier automatiquement.

## 5. Prérequis et risques identifiés

- **Accès réseau sortant** : le patch interroge les dépôts de paquets (Alpine, Debian) au moment de la construction ; le runner doit y avoir accès, et le résultat dépend de l'état de ces dépôts à cet instant. À documenter dans `docs/exploitation.md`.
- **Reproductibilité** : deux patchs de la même image à deux dates peuvent différer. Le job enregistre digest source, versions des outils, base Trivy et document VEX.
- **Entrée non fiable** : l'image source est traitée dans BuildKit ; plafonds de durée (`--timeout`), de mémoire, de disque et de taille d'image obligatoires.
- **Mémoire de pointe** : non mesurée sur de grosses images ; une file à un build par hôte est maintenue.

## 6. Non vérifié dans le spike

- BuildKit rootless et durcissements équivalents (seccomp, utilisateur non root).
- Authentification et TLS entre BuildKit/Copa et le registre du lot A (le banc utilisait un registre HTTP local sans authentification).
- Images à plusieurs plateformes et architectures autres que `linux/amd64`.
- Images applicatives : Copa ne corrige que les paquets du système ; les dépendances Node, Python, etc. restent hors du MVP (`remediation.md` §3.3).
- Comportement sur très grosses images (mémoire, disque, durée) et sur des dépôts de paquets lents ou indisponibles.
- Intégration à l'agent (messages typés, annulation, reprise) : le spike a été piloté à la main.

## 7. Conséquences

- Le lot suivant porte le modèle de données et l'exécution côté agent (messages versionnés, runner BuildKit+Copa+Trivy, rapport), adossé au registre du lot A.
- Avant de publier automatiquement, compléter le registre : comptes lecture / publication, liste des images, rétention (**fait**, voir §8).
- `remediation.md` §5.1 (« `docker save` n'est pas une entrée valide ») est confirmé : l'entrée valide est une image en registre, désignée par digest.

## 8. Évolutions depuis le spike (12 novembre 2026)

Décisions prises à l'implémentation, avec ce qui les motive. Le détail d'usage est dans `docs/exploitation.md` (« Correctifs d'images », « Registre d'images privé »).

1. **Le verdict reste celui du rescan** (§4.2) et s'y ajoutent deux contrôles que le moteur ne fait pas : une **vérification de démarrage** facultative par image (même commande sur l'image d'origine et sur l'image corrigée, dans un conteneur jetable sans réseau, en lecture seule, sans capacités, sans volume ni variable d'environnement ; refus en cas de régression) et la **confirmation de l'image par le registre** : la console interroge elle-même le registre et écarte un résultat dont le digest annoncé par l'agent n'y figure pas ou diffère. L'agent n'est donc pas cru sur parole pour ce qui devient une référence de déploiement.
2. **Aucun déploiement automatique, jamais.** « Utiliser l'image corrigée » crée une révision **non déployée** (référence par digest, ou changement de la variable qui porte l'image) ; le déploiement reste une action explicite. La préparation planifiée (désactivée par défaut) ne fait que **préparer** : une fois par contenu d'image, plafond par 24 h, pause après trois échecs, résultat « à relire ».
3. **Registre : deux comptes** (publication et lecture seule). Le registre ne sait pas limiter un compte à la lecture ; Traefik l'impose par un second routeur (toute méthode sauf GET et HEAD, `basicAuth` limité au compte de publication), vérifié sur Traefik 3.7 et registry 3.0. Seul le compte de lecture est transmis aux déploiements. **Limite assumée** : un registre joint sans passer par Traefik n'a que l'authentification du registre.
4. **Nettoyage du registre** : suppression par digest, jamais d'une image utilisée (révision courante, déployée ou ancienne, conteneur, correctif actif) ; rétention par nombre de correctifs conservés (proposée par défaut, automatique en option) ; **ramasse-miettes lancé par l'agent**, commande fixe dans le seul conteneur du registre officiel, jamais pendant un correctif, qui suspend le démarrage des correctifs pendant l'opération.
5. **Annulation** : l'arrêt est demandé à l'agent et n'est jamais affirmé avant sa confirmation ; sans confirmation, le résultat est « indéterminé ».
6. **Notifications** : webhook HTTPS sortant, signé, sans secret dans les messages, avec refus des adresses privées à l'enregistrement et à chaque envoi (résolution de nom comprise).
7. **Images d'infrastructure exclues** : les images du registre, de Traefik, de la console et de son agent ne sont jamais corrigées localement (dépendance circulaire : stockées dans un registre que seuls ces composants rendent joignable). Refus côté serveur, exclusion de la préparation automatique, mise à jour par une version officielle. Découvert après coup en usage réel (le bouton « Corriger » était proposé pour l'image du registre).
8. **Confidentialité** : les sorties d'outils (vérification, ramasse-miettes en notification) ne sont jamais transmises ni conservées, seulement ce qu'elles prouvent ; l'adresse et le secret du webhook sont chiffrés et jamais renvoyés ; les écritures de réglages sont réservées aux administrateurs.

### Revue de sécurité (lot Q1)

Revue de l'ensemble des routes (rôles), des messages console → agent, de la gestion des secrets et des appels sortants. Constats et suites :

- **Corrigé** : l'image annoncée par l'agent n'était pas recoupée avec le registre (voir 1) ; la liste des images du registre, ouverte à tout utilisateur, interrogeait le registre à chaque appel (mise en cache de 10 s) ; le nom d'hôte du webhook était visible des lecteurs (réservé aux administrateurs).
- **Vérifié sans écart** : aucune requête SQL construite par concaténation de données ; aucun `v-html` ni shell dans le code ajouté ; chaque route d'écriture exige au moins opérateur, chaque réglage administrateur ; les identifiants de registre ne passent que par un dossier temporaire 0700 (fichier 0600) supprimé à la fin ; messages agent → console liés à l'hôte et au job (résultats étrangers ou rejoués ignorés).
- **Risque résiduel assumé** : un agent compromis, qui détient déjà les droits de l'hôte, peut publier une image malveillante dans le registre avec les identifiants de son propre correctif ; le recoupement par la console limite la confiance accordée à ses résultats sans la supprimer. La signature des images (cosign) n'est pas implémentée.
