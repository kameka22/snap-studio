# Plans

Un plan par chantier en cours. Un plan terminé quitte ce dossier : il reste
consultable dans l'historique git (liens plus bas), et ce qui en reste à faire
rejoint les listes ci-dessous.

## En cours

| Plan | Sujet | État |
|---|---|---|
| [moteur.md](moteur.md) | Moteur de découpe embarqué (Snapmaker Orca allégé, téléchargé par Snap Studio) | Étapes 1 à 4 écrites ; reste la validation une fois `engine-orca-2.4.0` publiée |

## À valider sur la vraie machine

Fonctionnalités implémentées et testées hors matériel (navigateur sans
affichage, tests Rust), dont le comportement réel reste à vérifier.

- **Moteur embarqué** : première release `engine-orca-2.4.0` (découpe de test
  verte sur les quatre plateformes), puis téléchargement et découpe dans
  l'application sur une machine sans Snapmaker Orca.
- **Mises à jour automatiques** : release N installée, release N+1 publiée →
  la fenêtre s'ouvre, l'installation aboutit, l'application redémarre
  (macOS, Windows, Linux AppImage) ; fichier altéré refusé.
- **Autorisations macOS** : avec la signature ad hoc, une seule demande d'accès
  par dossier, et plus à chaque lancement (`tccutil reset All
  fr.carlini.snapstudio` pour repartir de zéro).
- **Température du plateau** : la découpe d'un PLA sur PEI texturé donne bien
  65 °C (et non 35 °C).
- **Impressions** : fin d'impression détectée, notification, proposition de la
  suivante (case « plateau libre ») ; pause, reprise, annulation depuis la
  fiche ; caméra dans la fiche.
- **Recherche réseau** : la U1 apparaît dans « Sur le réseau » (sinon :
  journal `[discover]` dans le terminal de `cargo tauri dev`).
- **Assistant de bienvenue** : premier lancement sur un compte neuf.

## Plus tard

Idées écartées ou reportées pendant les chantiers, sans ordre de priorité.

- **Préparer** : plusieurs plateaux ; coloration au pinceau ; découpe
  d'objets ; modificateurs et réglages par objet ; outils à poignées
  Déplacement et Échelle (peu utiles tant qu'on glisse l'objet et que
  l'inspecteur règle l'échelle).
- **Multicolore** : lire la peinture par triangle des 3MF (aujourd'hui ces
  modèles restent monocolores à la découpe).
- **Imprimantes** : balayage du sous-réseau (port 7125) si une imprimante
  n'apparaît pas en mDNS.
- **Profils** : profils personnels propres à Snap Studio (aujourd'hui : ceux
  de Snapmaker Orca s'il est installé, en lecture seule) ; page « Profils »
  autonome ; modification des profils.
- **Aperçu G-code** : vignettes de la vue Fichiers aux couleurs du filament
  (elles gardent les couleurs par trajectoire).
- **Signature** : Apple Developer ID (plus d'alerte Gatekeeper, autorisations
  conservées d'une mise à jour à l'autre) ou certificat auto-signé stable.
- **Moteur** : basculer sur un vrai binaire sans interface si Snapmaker en
  publie un (PR Snapmaker #1006, PR upstream #14161).
- **IA** : pont Blender / MCP, plateau éditable depuis la conversation,
  préservation des couleurs et des objets multiples.

## Plans terminés

| Plan | Sujet | Dans l'historique |
|---|---|---|
| IA | Onglet IA : conversation Claude Code, terminal, aperçu vivant | `git show 4e65ac3:PLAN-IA.md` |
| Découpe | Découpe intégrée, aperçu, têtes et filaments, envoi | `git show e3be17e:PLAN-DECOUPE.md` |
| Préparer | Plateau, sélection, rotation, orientation automatique, disposition | `git show e3be17e:PLAN-PREPARER.md` |
| Mises à jour | Builds multiplateformes, signature, mises à jour automatiques | `git show e3be17e:PLAN-MAJ.md` |
| Accueil | Assistant de bienvenue, recherche mDNS des imprimantes | `git show a073e0d:PLAN-ACCUEIL.md` |
| Impressions | Impressions en cours, file d'attente, historique | `git show 0c8eb89:PLAN-IMPRESSIONS.md` |
| Profils | Détail des profils, onglets d'Orca en français | `git show 0c8eb89:PLAN-PROFILS.md` |
