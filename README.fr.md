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
[Changelog](CHANGELOG.md) · [Feuille de route](#feuille-de-route) · [Contribuer](CONTRIBUTING.fr.md)

[English](README.md) · **Français**

<img src="docs/screenshots/files.png" alt="Snap Studio — vos fichiers 3MF en un coup d'œil" />

</div>

## Pourquoi Snap Studio

- **Tout le trajet dans une seule app** — trouver un modèle, préparer le
  plateau, découper avec le moteur Snapmaker Orca, envoyer, suivre à la
  caméra.
- **Pensé pour les quatre têtes de la U1** — les bobines chargées sont lues
  sur l'imprimante, les couleurs d'un modèle multicolore sont associées aux
  têtes, et revérifiées avant le lancement d'une impression.
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
Le plateau U1 comme dans Orca : déplacer, pivoter, mettre à l'échelle
(aussi axe par axe) avec des curseurs, dupliquer, poser sur une face,
orienter et disposer automatiquement, annuler — puis découper. Des objets
peuvent être mis de côté hors du plateau (non découpés) et remis d'un clic.
Chaque objet liste ses couleurs, peintes comprises, et envoie chacune vers
la tête de votre choix.

<img src="docs/screenshots/prepare.png" alt="Préparer" />

</td>
<td width="50%" valign="top">

### ✦ IA
Claude modifie une pièce ou en crée une à partir d'une description, dans
une discussion avec aperçu 3D en direct et chaque version gardée. Les
résultats sont des 3MF multicolores, prêts à découper. Les conversations se
recherchent, s'épinglent, se renomment, se dupliquent ; voir
[Concevoir avec l'IA](#concevoir-avec-lia).

<img src="docs/screenshots/ai-chat.png" alt="Une conversation IA" />

</td>
</tr>
<tr>
<td valign="top">

### 🖨 Imprimantes
Trouvées seules sur le réseau ; la U1 en 3D, ses pièces cliquables pour
les contrôles rapides (bobines, têtes, plateau, lumière) ; état en direct,
températures des quatre têtes, bobines chargées, leurs [fichiers et timelapses](#-fichiers-et-timelapses-de-limprimante)
et leur [entretien et nivellement](#-entretien-et-réglages). Fonctionne avec toute imprimante Klipper.

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
Studio propose la suivante (jamais seul), sur l'imprimante de votre choix.
Progression, résumé de découpe, températures, pause, annulation. Avant le
lancement, les [bobines sont vérifiées](#-vérification-des-bobines).

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

### 🔧 Entretien et réglages

Chaque imprimante a sa vue Entretien et réglages, en trois onglets : Contrôle, Entretien et Nivellement.

**Entretien**, construit à partir de ce que l'imprimante compte et du guide
de maintenance Snapmaker :

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

<img src="docs/screenshots/maintenance.png" alt="Entretien et réglages : entretiens et compteurs des têtes" />

**Nivellement** : le maillage du plateau, lu sur l'imprimante, gardé dans
le temps.

- Une carte dit l'état du plateau et la seule chose à faire : bon (compensé
  par le maillage de l'imprimante), à surveiller, hors tolérance, ou à
  remesurer. Les seuils par défaut (0,5 / 1 mm, trois niveaux) sont adaptés
  au U1, dont le maillage compense ce qui est en dessous ; il ne demande un
  nivellement manuel qu'au-delà de 2 mm.
- La surface en 3D ou en carte avec la hauteur de chaque point ;
  historique, tendance et comparaison de deux mesures.
- **Mesurer** avec un assistant : plateau confirmé dégagé (une impression
  qui vient de finir est signalée), température proposée d'après la
  dernière impression, puis chaque étape du U1 — chauffe, stabilisation de
  2 min, préchauffe, contrôle des coins, palpage — un arrêt propre ou
  d'urgence, et le résultat comparé à la mesure précédente.
- Quand le plateau demande de l'attention, sa forme est nommée et montrée
  sur la carte (côté qui penche, coin plus haut, plateau creux ou bombé,
  point isolé), avec quoi faire — sur un U1, les molettes sous le plateau
  et le nivellement manuel de l'imprimante — puis « J'ai corrigé :
  remesurer ».
- Un rappel dans Entretien après 30 jours ou 50 impressions, et « Mesurer
  d'abord » dans la fenêtre d'envoi quand le plateau est hors tolérance.

**Contrôle** : les actions de base de l'imprimante, sans G-code — aussi
accessible depuis la page de l'imprimante (**Contrôle**).

- Origine (tous les axes ou un seul), un pavé de déplacement X, Y et Z (de
  0,1 à 50 mm), la position en direct ; nettoyer la buse, aller à la
  position de purge.
- Une carte par tête, à la couleur de sa bobine : la température en jauge,
  la consigne au curseur, activer, charger, décharger, extruder, rétracter.
- La température du plateau ; le ventilateur de pièce, celui de la chambre,
  le purificateur et la lumière ; une petite vue caméra.
- Tout couper (chauffe), couper les moteurs, redémarrer le firmware, et
  l'arrêt d'urgence, toujours à portée.
- Sûr par construction : bloqué pendant une impression (seuls l'arrêt
  d'urgence, la lumière et la caméra restent), déplacements et changement de
  tête seulement après l'origine, Z jamais sous 0,5 mm, températures jamais
  au-dessus du maximum de chaque chauffe, une action à la fois ; ce qui ne
  peut pas se faire dit pourquoi.

### 📂 Fichiers et timelapses de l'imprimante

Sous chaque imprimante, **Fichiers** montre ce qui y est stocké, lu en direct :

- **Fichiers d'impression**, en liste ou en grille : vignette, durée,
  filament par tête, taille, résultat de leur dernière impression ;
  recherche et tri. **Imprimer** ouvre la même fenêtre qu'après une découpe
  — lancer là, mettre en file, ou imprimer sur une autre imprimante — et les
  têtes utilisées sont lues dans le fichier lui-même. Télécharger, renommer,
  supprimer, plusieurs à la fois ; le fichier en cours d'impression est
  protégé.
- **Timelapses**, lus directement depuis l'imprimante (vitesse 0,5×–4×,
  plein écran, précédente / suivante), téléchargés ou supprimés.
- **Partager** un fichier ou une vidéo : le menu de partage de macOS
  (AirDrop, Messages, Mail…), un QR code pour le télécharger sur votre
  téléphone sur le même Wi-Fi (un lien local qui s'arrête après 15 minutes ou
  à la fermeture de la fenêtre), le fichier dans le presse-papiers, ou
  Enregistrer sous.

<img src="docs/screenshots/printer-files.png" alt="Les fichiers d'une imprimante, en grille de vignettes" />

### ✂️ Découpe

Le moteur Snapmaker Orca, téléchargé une fois (environ 30 Mo) et tenu à
jour par l'app : inutile d'installer Snapmaker Orca. La fenêtre de découpe
place l'imprimante, le plateau et la qualité à gauche, les ajustements à
droite, les quatre têtes de la U1 et les couleurs du modèle en dessous :

- les bobines lues sur l'imprimante, chaque couleur de chaque objet envoyée
  vers sa tête, la surface du plateau (PEI texturé, PEI lisse…) et sa
  température ;
- remplissage, parois, supports, bordure, couture, les réglages avancés
  d'Orca, et leur enregistrement en profil perso ;
- **Vitesse** : un seul curseur de 50 % à 120 % du profil (vitesses × f,
  accélérations × f²), avec un panneau ⚙ qui montre chaque valeur, profil →
  calculée ; à 100 %, le G-code est celui du profil ;
- le détail de chaque profil tel que le moteur le reçoit.

Puis un aperçu des trajectoires avec durée, filament et coût, envoyé à
l'imprimante — avec son image sur l'écran de l'imprimante — ou enregistré en
G-code.

<img src="docs/screenshots/slicing.png" alt="La fenêtre de découpe" />

### 🎨 Vérification des bobines

Avant le lancement d'une impression — envoyée après une découpe, lancée
depuis la file ou depuis les fichiers d'une imprimante — chaque couleur du
modèle est comparée à la bobine chargée sur sa tête (matière, et couleur
telle que l'œil la voit). En cas d'écart, une fenêtre montre une ligne par
couleur avec les têtes possibles :

- choisissez une autre tête, et cette couleur sera imprimée par elle — pour
  cette impression seulement, via la table d'extrudeurs de l'imprimante, le
  G-code n'est pas réécrit ;
- ou **Modifier dans Préparer** : le plateau revient avec la fenêtre de
  découpe ouverte sur les bobines chargées.

La vérification se désactive dans Réglages → Préparer.

### 🌓 Affichage

Réglages → Affichage : clair, sombre ou comme le système ; dix thèmes,
chacun en version claire et sombre avec un aperçu en direct — Snap Studio,
Snapmaker Space (barre latérale bleu nuit), Contraste élevé, Graphite, Nuit
profonde, Papier, Nord, Solarized, Filament (l'app prend la couleur de la
bobine sur T0) et macOS (une mise en page façon Tahoe, en verre) ; la
couleur d'accent : celle du thème, du système, une couleur prédéfinie ou la
vôtre ; et des couleurs adaptées au daltonisme, avec tous les thèmes (les
états ne se distinguent jamais par le seul rouge / vert).

<img src="docs/screenshots/display.png" alt="Réglages › Affichage : apparence et les dix thèmes" />

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

Ce que chaque version a apporté : [CHANGELOG.md](CHANGELOG.md) (en anglais).

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

**Une conversation**, à partir d'un fichier (« Modifier avec l'IA » dans
Fichiers) ou de zéro : décrivez ce que vous voulez — des idées sont
proposées — choisissez où elle tourne et le modèle Claude. L'aperçu 3D et la
discussion sont côte à côte : chaque version exportée par Claude est gardée,
mesurée (taille, poids, étanchéité) et peut être réaffichée ;
**Enregistrer** met la version affichée dans vos fichiers, **Découper**
l'envoie dans Préparer. **Arrêter Claude** (ou Échap) interrompt une
réponse ; l'onglet **Terminal** montre la même session, en direct, comme le
ferait un terminal.

**La liste** des conversations : recherche, filtres, groupes par date,
épingles, renommer, dupliquer (mêmes fichiers, nouvelle session Claude).
**Supprimer** efface le dossier de la conversation et les fichiers de Claude
pour cette session — jamais vos 3MF enregistrés, jamais une autre session.

## FAQ

**Qu'est-ce qui a changé dans les dernières versions ?** Voir le
[changelog](CHANGELOG.md) (en anglais).

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
A disposer, ⌘D dupliquer, flèches 1 mm (⇧ : 10 mm), ⌘Z / ⇧⌘Z ; ⌘ + glisser
depuis le vide sélectionne avec un rectangle, ⇧-clic dans la liste
sélectionne une plage.

Dans la liste de l'IA : ⌘F rechercher, ↑ / ↓ et ⏎ ouvrir, F2 renommer,
⌫ supprimer. Dans une conversation : ⌘⏎ envoyer, Échap arrêter Claude.

Dans les fichiers d'une imprimante : ⏎ détail, Échap fermer ; dans le
lecteur : ← / → vidéo précédente / suivante, Espace pause, Échap retour.

## Feuille de route

Ce qui est sorti est dans le [changelog](CHANGELOG.md). Ce qui est prévu,
chacun avec sa pull request (brouillons, validés ou en discussion) :

| Fonction | |
|---|---|
| **Plusieurs plateaux dans Préparer** — onglets de plateaux, agencement automatique sur plusieurs plateaux, tout découper et l'envoyer dans la file ; les 3MF multi-plateaux gardés tels quels | [#18](https://github.com/kameka22/snap-studio/pull/18) |
| **Impression objet par objet** — un objet après l'autre, avec contrôle de collision pour la tête de la U1 et un ordre réglable | [#22](https://github.com/kameka22/snap-studio/pull/22) |
| **Alertes plateau et matière** — un plateau et un filament incompatibles signalés avant d'imprimer, et un conseil quand la colle est recommandée | [#16](https://github.com/kameka22/snap-studio/pull/16) |
| **Assistants de calibration** — PID des buses et du plateau, et input shaper, décalages entre têtes et mesure du débit guidés, dans Entretien et réglages | [#17](https://github.com/kameka22/snap-studio/pull/17) |
| **Filaments** — l'inventaire de vos bobines (poids déduit après chaque impression, alerte de stock bas) et les bonnes affaires | [#19](https://github.com/kameka22/snap-studio/pull/19) |
| **Espace Snapmaker** — Snapmaker Space, Store, Wiki, Forum et compte dans un menu, modèles ouverts directement dans Préparer | [#23](https://github.com/kameka22/snap-studio/pull/23) |
| **Barre de titre intégrée sous Windows et Linux** — la même fenêtre épurée que sous macOS | [#27](https://github.com/kameka22/snap-studio/pull/27) |
| **D'autres agents IA** — OpenCode à côté de Claude Code (OpenAI, Google, Mistral, modèles locaux…), un seul actif à la fois | [plan](docs/plans/ai-agents.md) |

Les travaux en cours, ce qui reste à vérifier sur une vraie imprimante et les
idées pour plus tard sont dans [`docs/plans/`](docs/plans/) (en anglais). Les
idées sont bienvenues dans les [Discussions](https://github.com/kameka22/snap-studio/discussions).

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
