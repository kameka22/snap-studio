# Plan — moteur de découpe embarqué (Snapmaker Orca allégé)

Objectif : Snap Studio ne dépend plus d'une installation de Snapmaker Orca. Il
télécharge **son propre moteur** — le binaire officiel de Snapmaker, allégé de
tout ce qui ne sert pas à découper — et ne se sert que de lui.

**État :** étapes 1 à 4 écrites — CI et scripts, `engine.rs`, interface
(assistant, fenêtre de découpe, Réglages), garde-fous et README. Reste la
validation (étape 5) une fois `engine-orca-2.4.0` publiée et `engine.json`
mis à jour. Tant que `src-tauri/engine.json` est vide, Snapmaker Orca installé
sert de repli.

Décisions prises :

- **un seul moteur** : celui téléchargé par Snap Studio (plus de recours à
  l'app installée pour la découpe) ;
- téléchargement **au premier besoin** (assistant de bienvenue, ou premier
  « Découper »), avec barre de progression ; le reste de l'application
  fonctionne sans ;
- moteur **reconditionné par notre CI** à partir de la release officielle,
  testé par une vraie découpe avant publication ;
- version **figée** dans Snap Studio ; une nouvelle version d'Orca passe par une
  mise à jour de Snap Studio.

## Mesures (Snapmaker Orca v2.4.0)

| Plateforme | Paquet officiel | Moteur allégé (tar.zst) | Sur le disque |
|---|---|---|---|
| macOS Apple Silicon | 252 Mo (dmg universel) | ~28 Mo | 117 Mo |
| macOS Intel | 252 Mo | ~33 Mo | 127 Mo |
| Windows x64 | 149 Mo (zip portable) | ~33 Mo | 112 Mo |
| Linux x64 | 132 Mo (AppImage) | ~38 Mo | 134 Mo |

Retiré : profils des 115 autres marques (77 Mo), interface web (61 Mo),
polices (36 Mo), images (19 Mo), calibration (14 Mo), traductions (9 Mo),
modèles d'exemple, fichiers de développement (`include/`, `lib/*.lib`).
Gardé : exécutable et bibliothèques **inchangés**, `profiles/Snapmaker` (+ son
index), `printers`, `info`, `data`, `cert`, `shaders`, `LICENSE`. Les profils
Snapmaker n'héritent d'aucun profil d'une autre marque (vérifié).

## 1. Liste des fichiers gardés — `engine/keep.txt`

Liste **autorisée** (et non liste d'exclusion) : un fichier ajouté par
Snapmaker dans une version future n'est jamais embarqué par accident.

```
# Chemins relatifs à la racine extraite, motifs glob, par plateforme.
[macos]
Snapmaker Orca.app/Contents/Info.plist
Snapmaker Orca.app/Contents/MacOS/*
Snapmaker Orca.app/Contents/Frameworks/*
Snapmaker Orca.app/Contents/Resources/profiles/Snapmaker/**
Snapmaker Orca.app/Contents/Resources/profiles/Snapmaker.json
Snapmaker Orca.app/Contents/Resources/{printers,info,data,cert,shaders}/**
[windows]
*.exe
*.dll
LICENSE.txt
resources/profiles/Snapmaker/**  …
[linux]
AppRun
bin/**
lib/**
libexec/**
resources/profiles/Snapmaker/** …
```

La structure des dossiers est conservée : le moteur cherche `resources` à
côté de son exécutable.

## 2. CI « moteur » — `.github/workflows/engine.yml`

Déclenchement manuel, paramètre `orca_version` (ex. `2.4.0`). Une fois par
version d'Orca, pas à chaque release de Snap Studio.

| Job | Runner | Paquet source | Traitement propre |
|---|---|---|---|
| macos-arm64 | `macos-latest` (ARM) | `Snapmaker_Orca_Mac_universal_V<v>.dmg` | `hdiutil attach -nobrowse -readonly`, `lipo -thin arm64` (exécutable, `crashpad_handler`, `libsentry.dylib`), **re-signature ad hoc** de l'app (`codesign --force --deep --sign -`) : retirer des ressources invalide le sceau de Snapmaker |
| macos-x64 | `macos-13` (Intel) | idem | `lipo -thin x86_64`, re-signature ad hoc |
| windows-x64 | `windows-latest` | `Snapmaker_Orca_Windows_V<v>_portable.zip` | décompression |
| linux-x64 | `ubuntu-24.04` | `Snapmaker_Orca_Linux_AppImage_Ubuntu2404_V<v>.AppImage` | `--appimage-extract` ; dépendances système installées pour le test (GTK 3, WebKitGTK 4.1, GStreamer) |

Étapes communes :

1. Télécharger le paquet officiel ; journaliser son SHA-256 (traçabilité).
2. Extraire, puis copier **uniquement** `keep.txt` dans `orca-<v>/`.
3. Ajouter `NOTICE.txt` : « Binaire officiel Snapmaker Orca v<v>, non
   modifié ; ressources inutiles à la découpe retirées
   [macOS : architecture séparée, signature ad hoc]. Licence AGPL-3.0
   (LICENSE.txt). Code source : https://github.com/Snapmaker/OrcaSlicer/tree/v<v> ».
4. **Test de découpe réelle** : construire Snap Studio (`cargo test --lib`)
   et lancer `slice::tests::full_job_produces_gcode` avec
   `SNAPSTUDIO_ENGINE=<dossier extrait>` et un 3MF de test (`engine/test/cube_2c.3mf`,
   deux couleurs, U1 0.4). Échec → rien n'est publié. Le test passe par la
   même préparation des profils que l'application (héritage, `nozzle_diameter`,
   plateau…), donc il valide le vrai chemin.
5. Compresser : `tar` + `zstd -19` → `snap-studio-engine-orca-<v>-<plateforme>.tar.zst`.
6. Job final : release **`engine-orca-<v>`** du dépôt Snap Studio avec les
   quatre archives et **`engine.json`** :

```json
{
  "engine": "snapmaker-orca",
  "version": "2.4.0",
  "platforms": {
    "macos-aarch64": { "url": "https://github.com/kameka22/snap-studio/releases/download/engine-orca-2.4.0/…-macos-arm64.tar.zst", "size": 28123456, "sha256": "…", "unpacked": 117000000, "entry": "Snapmaker Orca.app" },
    "macos-x86_64":  { … },
    "windows-x86_64": { …, "entry": "snapmaker-orca.exe" },
    "linux-x86_64":  { …, "entry": "AppRun" }
  }
}
```

Ce manifeste est ensuite commité dans `src-tauri/engine.json` (PR ou commit
manuel) : c'est ce qui fige la version utilisée par Snap Studio.

## 2 bis. Scripts : publier un moteur, publier Snap Studio

La release d'un moteur est **manuelle et rare** : seulement pour changer de
version d'Orca, jamais à chaque release de Snap Studio.

**`scripts/engine.sh <version>`** (ex. `scripts/engine.sh 2.4.0`) :

1. vérifie que la version existe dans les releases Snapmaker et affiche les
   tailles des quatre paquets officiels ;
2. refuse si `engine-orca-<version>` est déjà publiée (option `--force` pour
   reconstruire) ;
3. demande confirmation (`-y` pour s'en passer), comme `release.sh` ;
4. lance `engine.yml` (`gh workflow run engine.yml -f orca_version=<version>`)
   et suit son déroulement, test de découpe compris ;
5. une fois la release publiée, récupère `engine.json`, le copie dans
   `src-tauri/engine.json`, commite « Moteur Snapmaker Orca <version> » et
   pousse. Mêmes garde-fous que `release.sh` : copie de travail propre, sur
   la bonne branche, à jour avec GitHub.

**`scripts/release.sh`** gagne un garde-fou : avant de publier, il vérifie que
chaque archive de `src-tauri/engine.json` existe sur GitHub ; sinon il
s'arrête avec « Moteur <version> introuvable : lancez d'abord
`scripts/engine.sh <version>` ». Le job `version` de `build.yml` fait la même
vérification côté CI.

Séquence la première fois :

```sh
git push                     # engine.yml doit être sur GitHub
scripts/engine.sh 2.4.0      # construit, teste, publie le moteur, met à jour engine.json
scripts/release.sh           # publie Snap Studio qui sait le télécharger
```

Ensuite : `release.sh` seul ; `engine.sh` uniquement pour changer de version
d'Orca.

## 3. Rust — module `engine.rs`

- `include_str!("../engine.json")` : manifeste embarqué ; clé de plateforme
  depuis `std::env::consts::{OS, ARCH}`.
- Emplacement : `<données>/fr.carlini.snapstudio/engine/orca-<v>/`.
- Commandes :
  - `engine_status` → `{ version, installed, path, size_on_disk, download_size }` ;
  - `engine_install` → téléchargement en flux (`reqwest`), progression par
    évènement `engine-progress` (octets reçus / total), **vérification
    SHA-256** (`sha2`), décompression (`zstd` + `tar`) dans un dossier
    temporaire puis **renommage atomique** ; anciennes versions supprimées ;
    annulable ;
  - `engine_remove`.
- `slice::engine()` ne renvoie **que** le moteur installé ; s'il manque :
  erreur explicite `moteur non installé` que l'interface sait reconnaître.
  La variable `SNAPSTUDIO_ENGINE` (tests, CI) prend le pas.
- Détection actuelle (`slicers::executable` / `resources`) réutilisée telle
  quelle : la structure extraite est celle des paquets officiels
  (`.app` sur macOS, `exe` + `resources` sur Windows, `AppRun` + `bin/` +
  `resources/` sur Linux).
- Lancement du moteur avec **`--datadir <données>/engine/data`** : il n'écrit
  plus dans le dossier de Snapmaker Orca (journaux, cache) et n'en crée pas
  un sur une machine qui n'a jamais eu Orca.
- Profils :
  - **système** : ceux du moteur (`profiles/Snapmaker`) ;
  - **personnels** : lus dans le dossier de Snapmaker Orca **s'il existe**
    (comme aujourd'hui, en lecture seule) — aucun changement de comportement
    pour qui a déjà des profils ; des profils propres à Snap Studio pourront
    venir plus tard ;
  - préréglages choisis dans Orca : utilisés s'ils existent, sinon les
    valeurs par défaut de Snap Studio (U1 0,4 mm, 0.20mm Standard).
- `slicers::list()` reste pour « Ouvrir dans le trancheur » (indépendant).

## 4. Interface

- **Assistant de bienvenue** — nouvelle étape « Moteur de découpe » entre
  « Votre imprimante » et « Tout est prêt » : explication courte, taille,
  bouton **Télécharger** avec barre de progression, **Passer** possible.
  Le récapitulatif final remplace « Snapmaker Orca détecté » par l'état du
  moteur.
- **Premier « Découper » sans moteur** : la fenêtre de découpe affiche à la
  place de son contenu une carte « Le moteur de découpe doit être
  téléchargé (33 Mo) » + bouton + progression ; une fois installé, la
  fenêtre se remplit et la découpe peut partir. Même chose pour
  « Préparer » → bouton Découper.
- **Réglages → « Moteur de découpe »** : version, place occupée, état ;
  boutons **Réinstaller** et **Supprimer** ; lien « Licence et code source ».
- Message d'erreur clair si le téléchargement échoue (hors ligne, empreinte
  invalide) avec **Réessayer**.

## 4 bis. Nouvelle version du moteur

Une nouvelle version du moteur arrive **toujours avec une mise à jour de
Snap Studio** (version figée dans `engine.json`) : l'application n'interroge
jamais GitHub pour un moteur plus récent.

- Après la mise à jour de Snap Studio, le moteur référencé n'est pas installé
  mais un **ancien** l'est (`previous` dans le statut).
- **Au lancement**, le nouveau se télécharge **en arrière-plan** (4 s après
  le démarrage) ; toast « Moteur de découpe mis à jour (2.5.0) » à la fin.
  Une première installation, elle, reste à l'initiative de l'utilisateur.
- Partout (fenêtre de découpe, Réglages), la carte annonce une **mise à
  jour** : « Mise à jour du moteur de découpe : 2.4.0 → 2.5.0 », bouton
  « Mettre à jour ». Si l'utilisateur ouvre la découpe pendant le
  téléchargement de fond, il en voit la progression ; la fenêtre se remplit
  à la fin.
- Échec du téléchargement de fond (hors ligne…) : silencieux ; la fenêtre de
  découpe propose « Réessayer ».
- Pas de découpe avec l'ancien moteur en attendant : Snap Studio n'a été
  éprouvé qu'avec la version référencée.
- L'ancien moteur est supprimé une fois le nouveau installé.

## 5. Release de Snap Studio

- Le moteur n'est pas dans l'installateur : `build.yml` ne le construit pas.
- Vérification ajoutée au job `version` de `build.yml` (et à `release.sh`,
  voir 2 bis) : chaque `url` de `engine.json` répond (HEAD 200) — une release
  ne peut pas pointer vers un moteur absent.
- README : section « Moteur de découpe » (téléchargé au premier besoin,
  taille, licence, mise à jour via Snap Studio).

## 6. Vérification

- CI moteur : découpe réelle verte sur les quatre plateformes.
- Snap Studio sans Orca installé (machine propre ou compte neuf) :
  assistant → téléchargement → découpe → aperçu → envoi.
- Empreinte altérée → refus et message ; coupure réseau → reprise par
  « Réessayer » ; suppression puis réinstallation depuis les Réglages.
- Machine avec Orca installé : profils personnels toujours visibles ; la
  découpe utilise bien le moteur embarqué (journal du chemin du moteur).

## 7. Points d'attention

- **macOS** : la re-signature ad hoc est nécessaire (sceau invalidé par le
  retrait des ressources). Fichier téléchargé par l'app → pas de quarantaine,
  pas d'alerte Gatekeeper. Validé par le test de découpe sur les runners.
- **Linux** : le moteur utilise GTK 3, WebKitGTK 4.1 et GStreamer du système
  (déjà requis par Snap Studio) ; AppImage construite pour Ubuntu 24.04.
- **Windows** : exécutable décompressé par l'app → pas de marque « web »,
  pas d'alerte SmartScreen ; un antivirus peut ralentir le premier lancement.
- **Vignettes** du G-code : dessinées par le moteur avec OpenGL sur le poste ;
  sans contexte OpenGL (CI), il les omet sans échouer.
- **Licence AGPL** : `LICENSE.txt` et `NOTICE.txt` dans chaque archive, lien
  vers les sources exactes ; Snap Studio ne communique avec le moteur que par
  fichiers et ligne de commande.
- **À surveiller** : PR Snapmaker #1006 (outils « headless ») et PR upstream
  #14161 (SliceCore) — un vrai binaire sans interface serait encore plus
  léger, et se brancherait sans changement côté Snap Studio.

## Étapes

1. `keep.txt`, 3MF de test, `engine.yml` (extraction, allègement, signature,
   test, publication), `scripts/engine.sh` — première release
   `engine-orca-2.4.0`.
2. `engine.rs` : manifeste, téléchargement, vérification, décompression,
   commandes ; `slice::engine()` et `--datadir`.
3. Interface : étape de l'assistant, carte dans la fenêtre de découpe,
   section des Réglages.
4. Vérification de `engine.json` dans `build.yml` et `release.sh`, README,
   notice.
5. Validation sur une machine sans Orca.
