<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="128" alt="Icône de Snap Studio" />

# Snap Studio

**L'atelier de bureau de votre Snapmaker U1 — du fichier à l'impression.**

[![Dernière version](https://img.shields.io/github/v/release/kameka22/snap-studio?label=version&color=0a84ff)](https://github.com/kameka22/snap-studio/releases/latest)
[![Téléchargements](https://img.shields.io/github/downloads/kameka22/snap-studio/total?label=t%C3%A9l%C3%A9chargements&color=30d158)](https://github.com/kameka22/snap-studio/releases)
[![Licence : GPL v3](https://img.shields.io/badge/licence-GPL--3.0-ffd60a)](LICENSE)
![macOS · Windows · Linux](https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-lightgrey)

[**Télécharger**](https://github.com/kameka22/snap-studio/releases/latest) ·
[Fonctions](#fonctions) · [IA](#concevoir-avec-lia) · [FAQ](#faq) ·
[Contribuer](CONTRIBUTING.fr.md)

[English](README.md) · **Français**

<img src="docs/screenshots/files.png" alt="Snap Studio — vos fichiers 3MF en un coup d'œil" />

</div>

## Pourquoi Snap Studio

- **Tout le trajet dans une seule app** — trouver un modèle, préparer le
  plateau, découper avec le moteur Snapmaker Orca, envoyer, suivre à la
  caméra.
- **Pensé pour les quatre têtes de la U1** — les bobines chargées sont lues
  sur l'imprimante, les couleurs d'un modèle multicolore sont associées aux
  têtes.
- **Concevoir avec l'IA** — décrivez une modification ou une nouvelle
  pièce ; Claude la modélise, vous la voyez prendre forme en 3D, version
  après version.

## Fonctions

**📁 Fichiers** — miniatures de vos fichiers 3MF (Orca, Bambu, Prusa,
MakerWorld) ou rendu 3D quand il n'y en a pas ; durée, filament, plateaux ;
visionneuse 3D et trajectoires G-code couche par couche.

<table>
<tr>
<td width="50%" valign="top">

### 🧩 Préparer
Le plateau U1 comme dans Orca : déplacer, pivoter, mettre à l'échelle,
dupliquer, poser sur une face, orienter et disposer automatiquement,
annuler — puis découper. Chaque objet liste ses couleurs, peintes
comprises, et envoie chacune vers la tête de votre choix.

<img src="docs/screenshots/prepare.png" alt="Préparer" />

</td>
<td width="50%" valign="top">

### ✦ IA
Claude modifie une pièce ou en crée une à partir d'une description, dans
une discussion avec aperçu 3D en direct et chaque version gardée. Les
résultats sont des 3MF multicolores, prêts à découper.

<img src="docs/screenshots/ai-chat.png" alt="Une conversation IA" />

</td>
</tr>
<tr>
<td valign="top">

### 🖨 Imprimantes
Trouvées seules sur le réseau ; état en direct, températures des quatre
têtes, bobines chargées, et leur [maintenance](#-maintenance). Fonctionne
avec toute imprimante Klipper.

<img src="docs/screenshots/printer.png" alt="L'imprimante et ses bobines" />

</td>
<td valign="top">

### 📷 Caméra
La caméra de l'imprimante, en direct, depuis la page de l'imprimante et
depuis chaque impression.

<img src="docs/screenshots/printer-camera.png" alt="La caméra de l'imprimante" />

</td>
</tr>
<tr>
<td valign="top">

### ⏱ Impressions
Impressions en cours et file d'attente : quand l'une se termine, Snap
Studio propose la suivante (jamais seul). Progression, résumé de découpe,
températures, pause, annulation.

<img src="docs/screenshots/print-job.png" alt="Une impression en cours" />

</td>
<td valign="top">

### 📚 Bibliothèque
MakerWorld, Printables, Thingiverse et Cults3D en onglets, sessions
conservées ; les téléchargements arrivent dans Fichiers ; favoris dans la
barre latérale.

<img src="docs/screenshots/library.png" alt="Bibliothèque" />

</td>
</tr>
</table>

### 🔧 Maintenance

Chaque imprimante a sa vue maintenance, construite à partir de ce que
l'imprimante compte et du guide de maintenance Snapmaker :

- **Utilisation** : temps d'impression, nombre d'impressions, filament
  consommé, plus longue impression.
- **Têtes** (U1) : changements de tête, avancement vers le nettoyage des
  contacts (tous les 100 000 changements), erreurs de prise et nouvelles
  tentatives — une tête en erreur est signalée — et son hotend (standard ou
  haut débit).
- **Entretiens** triés par urgence — contacts des têtes, billes et tiges
  d'accrochage, tiges linéaires et axe X, vis de l'axe Z, buses, plateau —
  avec leur échéance, « dans 80 h » ou « en retard de 296 h ». Chacun se
  déplie sur ses étapes, le passage de la vidéo Snapmaker et le guide ;
  **Fait** le note avec les compteurs du moment, et la prochaine échéance
  part de là (annulable depuis la notification).
- Une pastille dans la barre latérale quand un entretien est à faire. Rien
  n'est écrit dans l'imprimante.

Les contacts suivent le chiffre de Snapmaker ; les autres intervalles sont
des valeurs prudentes, Snapmaker n'en donne pas. Sur une autre imprimante
Klipper, la vue garde l'utilisation et les entretiens à l'heure.

<img src="docs/screenshots/maintenance.png" alt="La vue maintenance" />

**Découpe** — le moteur Snapmaker Orca, téléchargé une fois (environ 30 Mo)
et tenu à jour par l'app : inutile d'installer Snapmaker Orca. Choix de la
surface du plateau (PEI texturé, PEI lisse…), détail de chaque profil tel
que le moteur le reçoit, aperçu des trajectoires avec durée, filament et
coût, puis envoi à l'imprimante ou enregistrement du G-code.

## Télécharger

| Système | Fichier, dans la [dernière version](https://github.com/kameka22/snap-studio/releases/latest) |
|---|---|
| macOS (Intel et Apple Silicon) | `Snap-Studio_…_macos-universal.dmg` |
| Windows | `Snap-Studio_…_x64-setup.exe` |
| Linux | `Snap-Studio_…_amd64.AppImage` (ou `.deb`) |
| Linux ARM (Raspberry Pi 4/5…) | `Snap-Studio_…_arm64.AppImage` (ou `.deb`) — pas encore de moteur de découpe pour ARM |

Les paquets ne sont pas encore signés par Apple ou Microsoft. Premier
lancement sur macOS : clic droit → Ouvrir (ou
`xattr -dr com.apple.quarantine "/Applications/Snap Studio.app"`) ; sous
Windows : « Informations complémentaires » → « Exécuter quand même ».

Un **assistant de bienvenue** règle tout : langue, dossier de modèles,
imprimante sur le réseau, moteur de découpe et IA. Ensuite, **l'app se met
à jour toute seule** (sous Linux, l'AppImage).

## Concevoir avec l'IA

L'IA utilise [Claude Code](https://docs.claude.com/en/docs/claude-code/setup)
avec votre compte Claude, soit dans un bac à sable (un conteneur isolé),
soit directement sur votre ordinateur. L'assistant de bienvenue et
Réglages → IA vérifient ce dont votre choix a besoin et indiquent comment
installer ce qui manque ; un mode s'ouvre dès que tout est prêt.

| | Bac à sable | Cet ordinateur |
|---|---|---|
| Claude Code 2.1.286 ou plus récent, connecté | ✓ | ✓ |
| [yolobox](https://github.com/finbarr/yolobox) | ✓ | |
| Un moteur de conteneur démarré : Docker (ou OrbStack), Podman ou `container` d'Apple | ✓ | |
| Python 3 avec `trimesh`, `manifold3d`, `numpy` | | ✓ |

## FAQ

**Faut-il Snapmaker Orca ?** Non. Snap Studio télécharge son propre moteur.
Si Snapmaker Orca est installé, ses profils personnalisés sont proposés
aussi.

**Et avec une autre imprimante ?** L'état de l'imprimante et l'envoi
fonctionnent avec toute imprimante Klipper (Moonraker) ; le plateau, les
profils et les têtes sont ceux de la U1.

**Qu'est-ce qui sort de mon ordinateur ?** Aucune télémétrie. Snap Studio
échange avec GitHub (vérifier les mises à jour, télécharger le moteur), vos
imprimantes sur le réseau local, les sites ouverts dans la Bibliothèque et,
si vous utilisez l'IA, Anthropic par Claude Code.

**Pourquoi macOS m'avertit-il au premier lancement ?** L'app n'est pas
encore signée avec un certificat de développeur Apple ; les commandes
ci-dessus l'ouvrent quand même.

**J'utilisais 3MF Studio.** C'était l'ancien nom de Snap Studio : réglages,
imprimantes, favoris et conversations sont repris au premier lancement.

## Raccourcis

| | |
|---|---|
| ⌥⌘1 … ⌥⌘4 | Bibliothèque / IA / Fichiers / Préparer |
| ⌘O · ⌘R · ⌘F | ouvrir un dossier · actualiser · rechercher |
| ⌘1 / ⌘2 | vignettes / liste |
| ⏎ · double-clic | préparer (ajouter au plateau) ; G-code : trajectoires |
| V | vue 3D |
| ⌘⌫ | mettre à la corbeille |
| ⌘, | Réglages |

Dans Préparer : R pivoter, F poser sur une face, Q orienter (⇧Q : tout),
A disposer, ⌘D dupliquer, flèches 1 mm (⇧ : 10 mm), ⌘Z / ⇧⌘Z.

## Feuille de route

Ce qui est en cours et ce qui arrive se trouve dans [`docs/plans/`](docs/plans/).
Les idées sont bienvenues dans les [Discussions](https://github.com/kameka22/snap-studio/discussions).

## Contribuer

Bugs, idées, code ou traductions : voir [CONTRIBUTING.fr.md](CONTRIBUTING.fr.md).
Depuis l'app, **Réglages → À propos** (ou le menu **Aide**) ouvre un
signalement de bug avec la version et le système déjà remplis. Compiler,
publier, l'organisation du code : [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
(en anglais).

## Licence et remerciements

Snap Studio est un logiciel libre, sous [GNU General Public License v3](LICENSE)
ou ultérieure. Construit avec [Tauri](https://tauri.app) et Rust.

- Moteur de découpe : [Snapmaker Orca](https://github.com/Snapmaker/OrcaSlicer)
  (AGPL-3.0), lui-même basé sur [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) ;
  les éléments du plateau U1 viennent de ses profils (AGPL-3.0).
- Bibliothèques de l'interface : [marked](https://github.com/markedjs/marked),
  [DOMPurify](https://github.com/cure53/DOMPurify),
  [xterm.js](https://github.com/xtermjs/xterm.js) — voir `ui/vendor/NOTICE.md`.

Snap Studio est un projet indépendant, ni affilié ni approuvé par
Snapmaker. Snapmaker et U1 sont des marques de leurs propriétaires.
