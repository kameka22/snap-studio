# Snap Studio

Atelier de bureau pour la **Snapmaker U1** : explorer ses fichiers 3MF et G-code,
préparer le plateau, découper avec le moteur de Snapmaker Orca et envoyer
l'impression, sans quitter l'application.

macOS en priorité (interface AppKit), Windows et Linux également — Rust +
Tauri 2, interface web sans dépendance npm.

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
les couleurs d'un modèle multicolore sont associées aux têtes. Aperçu des
trajectoires avec durée, filament et coût, puis enregistrement du G-code ou
envoi à l'imprimante (nivellement, calibration du débit, timelapse).

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

Au premier lancement, un **assistant de bienvenue** fait choisir le dossier de
modèles et trouve l'imprimante sur le réseau (ou sa saisie à la main) ; il
reste accessible depuis Réglages → Application et le menu Aide. Sur macOS, la
recherche réseau demande une fois l'accès au réseau local.

Ensuite, **l'application se met à jour seule** : au lancement, elle propose
la nouvelle version, la télécharge, vérifie sa signature et redémarre
(Réglages → Application ; menu Snap Studio → Rechercher les mises à jour). Sous
Linux, seule l'AppImage se met à jour ; le `.deb` renvoie vers GitHub.

La découpe nécessite [Snapmaker Orca](https://github.com/Snapmaker/OrcaSlicer)
installé (moteur et préréglages), cherché dans `/Applications` (macOS),
`Program Files` (Windows), ou en AppImage dans `~/Applications`,
`~/Downloads`, `/opt` (Linux).

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

La signature des mises à jour utilise la clé des secrets GitHub
`TAURI_SIGNING_PRIVATE_KEY` et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` ; sa clé
publique est dans `tauri.conf.json` (voir `PLAN-MAJ.md`).

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
```

Snap Studio s'appelait auparavant 3MF Studio : ses données (réglages,
imprimantes, favoris, conversations) sont reprises au premier lancement.
