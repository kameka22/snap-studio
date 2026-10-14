# Snap Studio

[English](README.md) · **Français**

Atelier de bureau pour la **Snapmaker U1** : explorer ses fichiers 3MF et G-code,
préparer le plateau, découper avec le moteur de Snapmaker Orca et envoyer
l'impression, sans quitter l'application.

macOS en priorité (interface AppKit), Windows et Linux également — Rust +
Tauri 2, interface web sans dépendance npm. Interface en anglais et en
français.

![Snap Studio — vue Préparer](docs/screenshot.png)

## Fonctionnalités

**Fichiers** — vignettes extraites des 3MF (Orca, Bambu, Prusa, MakerWorld) ou
rendues en 3D quand il n'y en a pas ; métadonnées (durée, filament, bobines,
plateaux) ; vignettes ou liste triable, recherche, sélection multiple, mise à la
corbeille ; visualiseur 3D WebGL2 ; aperçu G-code couche par couche.

**Préparer** — le plateau de la U1 avec son motif, comme dans Orca. Déplacer,
tourner (anneaux de rotation), mettre à l'échelle, dupliquer, disposer
automatiquement, poser sur une face, orienter automatiquement (règles d'Orca),
annuler / rétablir, enregistrer le plateau en 3MF.

**Découpe** — le moteur de Snapmaker Orca tourne en arrière-plan. Les bobines
montées sur l'imprimante sont lues pour choisir les filaments, tête par tête ;
les couleurs d'un modèle multicolore sont associées aux têtes. Choix du
plateau (PEI texturé, PEI lisse, effet graphique), qui fixe la température du
plateau lue dans chaque filament. Détail de chaque profil (ⓘ) tel qu'il part
au moteur, avec les onglets d'Orca dans la langue de l'interface. Aperçu des trajectoires avec
durée, filament et coût, puis enregistrement du G-code ou envoi à
l'imprimante (nivellement, calibration du débit, timelapse).

**Impressions** — impressions en cours et file d'attente dans la barre
latérale. Une imprimante occupée ? La découpe part en file ; à la fin de
l'impression, Snap Studio propose de lancer la suivante (jamais seul, plateau
libéré confirmé) et envoie une notification. Fiche de chaque impression :
vignette, progression, bilan de la découpe, profils, températures, caméra,
pause / reprise / annulation ; historique des 20 dernières.

**Imprimantes** — recherche automatique des U1 sur le réseau local (mDNS,
comme Snapmaker Orca) ; statut en direct par WebSocket Moonraker : état,
progression, températures des quatre têtes, bobines chargées, caméra.
Fonctionne avec toute imprimante Klipper.

**Bibliothèque** — MakerWorld, Printables, Thingiverse et Cults3D dans des
onglets natifs, sessions conservées ; les téléchargements arrivent dans
Fichiers ; favoris « à imprimer ».

**IA** — conversations Claude Code pour créer ou modifier des modèles, avec
terminal et aperçu du résultat.

## Installation

Télécharger la dernière version dans les
[Releases](https://github.com/kameka22/snap-studio/releases) :

| Système | Fichier |
|---|---|
| macOS (Intel + Apple Silicon) | `…_macos-universal.dmg` |
| Windows | `…_x64-setup.exe` |
| Linux | `…_amd64.AppImage` (ou `.deb`) |

Les paquets ne sont pas signés chez Apple ni chez Microsoft. Au premier
lancement : sur macOS, clic droit → Ouvrir (ou
`xattr -dr com.apple.quarantine "/Applications/Snap Studio.app"`) ; sur
Windows, « Informations complémentaires » → « Exécuter quand même ».

Au premier lancement, un **assistant de bienvenue** fait choisir la langue
(celle du système est proposée), le dossier de modèles, et trouve l'imprimante sur le réseau (ou sa saisie à la main) ; il
reste accessible depuis Réglages → Application et le menu Aide. Sur macOS, la
recherche réseau demande une fois l'accès au réseau local.

Ensuite, **l'application se met à jour seule** : au lancement, elle propose
la nouvelle version, la télécharge, vérifie sa signature et redémarre
(Réglages → Application ; menu Snap Studio → Rechercher les mises à jour). Sous
Linux, seule l'AppImage se met à jour ; le `.deb` renvoie vers GitHub.

**Moteur de découpe** : Snap Studio n'a pas besoin de Snapmaker Orca installé.
Il télécharge au premier besoin (assistant de bienvenue ou première découpe)
son propre moteur, environ 30 Mo : le binaire officiel de
[Snapmaker Orca](https://github.com/Snapmaker/OrcaSlicer), allégé de ce qui ne
sert pas à découper (profils des autres marques, interface, polices…) et
éprouvé par une découpe réelle sur chaque plateforme. Il est rangé dans les
données de Snap Studio (rien n'apparaît dans Applications) ; Réglages → Moteur
de découpe pour le réinstaller ou le supprimer. Licence AGPL-3.0, code source
lié depuis les Réglages. Les profils personnels de Snapmaker Orca, s'il est
installé, restent proposés.

## Développement

```sh
cargo tauri dev                    # développement
cargo tauri build --bundles app    # build local
npx @tauri-apps/cli icon src-tauri/app-icon.svg -o src-tauri/icons   # icônes
```

**Publier une version** : `scripts/release.sh` (CLI `gh` requise), sur `main`
propre et à jour. Il affiche la version actuelle et celle à publier, demande
confirmation, incrémente la version (`tauri.conf.json`, `Cargo.toml`), commite
« Version x.y.z », pousse, puis lance `.github/workflows/build.yml`, qui
construit macOS, Windows et Linux, signe les paquets et publie la release
`vx.y.z` avec son `latest.json`. `--minor` / `--major` pour changer de niveau,
`--version 1.2.3` pour une version exacte (plus récente que la dernière) ;
une version pas encore publiée (build en échec) est réutilisée sans bump.

**Changer de version du moteur** : `scripts/engine.sh 2.5.0` lance le workflow
« Moteur » (`.github/workflows/engine.yml`) : paquet officiel → liste autorisée
(`engine/keep.txt`) → découpe de test → release `engine-orca-2.5.0`, puis met
à jour `src-tauri/engine.json`. La release suivante de Snap Studio l'embarque ;
`release.sh` refuse un moteur référencé introuvable.

La signature des mises à jour utilise la clé des secrets GitHub
`TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ; sa clé
publique est dans `tauri.conf.json`.

Plans de travail en cours et idées pour la suite : [`docs/plans/`](docs/plans/).

### Langues

L'anglais est la langue de référence ; le français est une traduction. Les
textes vivent dans `ui/i18n/<langue>.json`, partagés entre l'interface et le
Rust (menus, messages). Pour ajouter une langue :

1. copier `ui/i18n/en.json` vers `ui/i18n/<code>.json` et le traduire ;
2. la déclarer dans `src-tauri/src/i18n.rs` (`LANGS`, catalogue) et dans
   `ui/i18n.js` (`LANG_NAMES`, `LOCALES`) ;
3. l'ajouter à `LANGS` dans `scripts/gen-orca-settings.py` et relancer le
   script (onglets d'Orca), puis à `CFBundleLocalizations` dans
   `src-tauri/Info.plist` avec un `src-tauri/locales/<code>.lproj` ;
4. `python3 scripts/check-i18n.py` signale les clés manquantes ou inutilisées
   et le texte resté en dur.

## Raccourcis

| | |
|---|---|
| ⌥⌘1 … ⌥⌘4 | Bibliothèque / IA / Fichiers / Préparer |
| ⌘O · ⌘R · ⌘F | ouvrir un dossier · actualiser · rechercher |
| ⌘1 / ⌘2 | vignettes / liste |
| ⏎ · ⌘⏎ | ouvrir dans le trancheur · ajouter à son plateau |
| V | vue 3D |
| ⌘⌫ | mettre à la corbeille |
| ⌘, | Réglages |

Dans Préparer : R rotation, F poser sur une face, Q orienter (⇧Q : tout),
A disposer, ⌘D dupliquer, flèches 1 mm (⇧ : 10 mm), ⌘Z / ⇧⌘Z.

## Organisation

```
ui/               interface HTML/CSS/JS, un fichier par vue
  i18n/           textes de l'interface, un fichier par langue (en, fr)
  i18n.js         traduction, formats de nombres et de dates, changement de langue
  assets/orca-settings.<langue>.json   onglets et libellés d'Orca
                  (générés par scripts/gen-orca-settings.py)
  assets/bed/     plaque et logo de la U1 (profils Snapmaker Orca, AGPL-3.0)
src-tauri/src/
  lib.rs          commandes Tauri, protocoles mesh:// gcode:// thumb:// cam://
  plate.rs        plateau, scène à découper    orient.rs     orientation auto
  slice.rs        découpe en arrière-plan      presets.rs    préréglages Orca
  printers.rs     Moonraker : statut, envoi    watch.rs      WebSocket temps réel
  model3mf.rs     lecture 3MF                  write3mf.rs   écriture 3MF
  mesh.rs stl.rs  géométrie                    gcode.rs      analyse G-code
  render.rs       vignettes 3D logicielles     thumbs.rs     cache des vignettes
  library.rs      Bibliothèque                 favorites.rs  favoris
  ia.rs pty.rs    conversations IA, terminal   slicers.rs    trancheurs installés
  menu.rs         menus natifs                 migrate.rs    reprise de 3MF Studio
  update.rs       mises à jour (GitHub, signature, installation)
  discover.rs     recherche des imprimantes sur le réseau (mDNS)
  jobs.rs         impressions : file d'attente, historique, suivi de fond
  engine.rs       moteur de découpe embarqué : téléchargement, vérification
  access.rs       premier accès aux dossiers protégés de macOS (une demande)
  i18n.rs         langue de l'interface, catalogues partagés avec ui/i18n
```

Snap Studio s'appelait auparavant 3MF Studio : ses données (réglages,
imprimantes, favoris, conversations) sont reprises au premier lancement.
