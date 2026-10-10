# Snap Studio

Explorateur de fichiers 3MF (impression 3D) : aperçu visuel immédiat, tri, suppression.
Application native macOS/Linux/Windows — Rust + Tauri 2, interface web sans dépendance npm.

## Fonctionnalités

- **Aperçu de chaque fichier.** La vignette intégrée par le slicer est extraite du conteneur
  (Bambu Studio / Orca `Metadata/plate_1.png`, PrusaSlicer `Metadata/thumbnail.png`,
  images MakerWorld). Quand le fichier n'en contient aucune, la géométrie est lue et
  **rendue en 3D par l'application** (rastériseur logiciel, couleurs des matériaux du modèle).
- **Métadonnées lues dans le fichier** : titre, créateur, licence, description, logiciel,
  durée d'impression estimée, poids de filament, bobines utilisées avec leurs couleurs,
  nombre de plateaux et de pièces.
- **Visualiseur 3D** : la géométrie du fichier est envoyée telle quelle au
  navigateur intégré (protocole `mesh://`, tampon binaire) et rendue en WebGL2
  sans bibliothèque. Orbite, déplacement, zoom, recadrage, plateau de la U1 à
  l'échelle (270 × 270 mm, quadrillage 10 mm), couleurs des matériaux du modèle,
  encombrement et nombre de triangles. Accès par le bouton « Vue 3D » de
  l'aperçu, par un clic sur l'aperçu, ou par la touche V.
- **Deux affichages** : vignettes (taille réglable) ou liste détaillée à colonnes triables.
- **Tris** : nom, date, taille, durée d'impression, poids de filament, sous-dossier,
  par le bouton de tri de la barre d'outils (menu natif) ou les en-têtes de la liste.
- **Recherche** sur le nom, le titre, le créateur et les pièces.
- **Suppression** vers la corbeille système, à l'unité ou par sélection multiple,
  confirmée par une alerte native.
- **Sélection multiple** de quatre façons : case à cocher au survol de chaque vignette,
  lasso tracé à la souris dans le vide, ⌘-clic (ajout) et ⇧-clic (plage), ⌘A (tout).
  Une barre flottante affiche le nombre de fichiers et leur poids total, avec la
  suppression groupée vers la corbeille.
- Navigation au clavier, menus contextuels natifs, glisser-déposer d'un dossier,
  dossiers récents dans la barre latérale.
- Cache disque des vignettes, invalidé automatiquement si le fichier change.

## Interface macOS

L'interface reproduit une application AppKit, sans bibliothèque d'interface :
un seul fichier de jetons CSS (`ui/style.css`), la police système et les
contrôles natifs du webview quand ils ressemblent déjà à macOS.

- **Fenêtre** : barre de titre en surimpression (feux tricolores dans la barre
  latérale), vibrancy `NSVisualEffectMaterial::Sidebar` sur toute la fenêtre,
  zone de contenu opaque par-dessus. La fenêtre est créée invisible et affichée
  après le premier rendu, sans flash blanc.
- **Barre latérale** translucide : Fichiers, Bibliothèque, IA, puis les dossiers
  récents et les imprimantes, Réglages en pied. Une seule sélection à la fois,
  sans transition ; elle passe au gris quand la fenêtre perd le focus.
- **Barre d'outils** unique de 52 px, qui sert aussi à déplacer la fenêtre :
  titre et sous-titre de la vue, puis ses contrôles (recherche, bouton « + »
  ouvrant un menu natif…).
- **Clair ou sombre** selon le réglage du système uniquement ; la **couleur
  d'accent** du système recolore l'application sans relance.
- **Natif partout où c'est possible** : barre de menus complète avec les
  raccourcis, menus contextuels, alertes de confirmation, dialogues de fichiers.
  Les menus sont décrits par l'interface et construits côté Rust
  (`src-tauri/src/menu.rs`) ; chaque entrée porte un identifiant
  `verbe:argument` renvoyé à la webview par un gestionnaire unique.
- **Feuilles modales** (découpe, imprimante, conversation) qui descendent de la
  barre de titre ; **toasts** en capsule en bas de fenêtre.
- **Icône** : la U1 de l'écran Imprimantes sur un carré arrondi en dégradé,
  générée depuis `src-tauri/app-icon.svg` (voir Utilisation).

## Bibliothèque

Un onglet qui embarque les sites de modèles — MakerWorld, Printables,
Thingiverse, Cults3D — dans de véritables vues natives, avec plusieurs onglets
ouverts en parallèle.

- **Connexion persistante** : on se connecte une fois, la session survit au
  redémarrage. Clic droit sur un onglet pour se déconnecter d'un site — seuls
  ses cookies sont effacés, les autres sessions restent.
- **Téléchargements** dirigés vers le dossier Téléchargements, sans écraser un
  fichier existant. À la fin, l'application bascule vers Fichiers, rafraîchit et
  sélectionne le nouveau modèle.
- **Favoris** : le bouton ★ met la page de côté. Titre, description et vignette
  sont relus côté Rust dans les balises `og:` de la page ; si elle résiste, le
  titre est déduit de l'adresse. L'onglet « Mes prints » les présente en galerie,
  à faire d'abord, avec ouverture, marquage et retrait.
- Les onglets ouverts sont retrouvés au lancement suivant, et les vues ne sont
  recréées qu'à la première visite de l'onglet.

### La contrainte des vues natives

Ces vues se dessinent **au-dessus** de l'interface HTML, dans le rectangle
qu'on leur assigne. Trois conséquences, traitées une fois pour toutes :

- les feuilles modales et le visualiseur 3D déclenchent leur effacement, via un
  observateur unique sur l'état des surcouches ; les menus et les alertes,
  natifs, passent devant d'eux-mêmes ;
- les notifications de la Bibliothèque s'affichent dans la barre d'adresse, pas
  en bulle, qui tomberait derrière la page ;
- wry positionne une vue fille par rapport à la **fenêtre entière** alors que nos
  coordonnées partent du haut de la page : l'écart se déduit de la hauteur
  déclarée par la fenêtre moins celle de notre page, jamais codé en dur.

## Découpe intégrée

Le moteur de Snapmaker Orca est lancé **en tâche de fond** : aucune fenêtre ne
s'ouvre, l'application reste maîtresse du déroulé. Le résultat est un G-code
posé à côté du modèle, nommé avec sa matière et sa durée
(`piece_PLA_1h24m.gcode`), qui s'ouvre aussitôt dans le visualiseur de
trajectoires.

Bouton **Découper** dans le panneau de détail. La fenêtre propose l'imprimante,
le profil d'impression et le filament — **vos préréglages personnels compris**,
signalés « perso » — pré-remplis avec ce que vous avez sélectionné dans Orca,
puis avec votre dernier choix, mémorisé par imprimante.

Cinq réglages rapides posés par-dessus le préréglage : hauteur de couche,
remplissage, parois, supports, bordure. Ce qui n'est pas touché garde la valeur
du profil Snapmaker.

### Ce qu'il fallait comprendre pour que ça marche

| Écueil | Traitement |
|---|---|
| Les préréglages sont des différentiels avec `inherits` | résolution complète de la chaîne |
| Le moteur exige `type`, `from`, `instantiation` | ajoutés aux configurations écrites |
| `normalize_fdm` lit `wipe_tower_filament` et `nozzle_diameter` dans le même objet | `nozzle_diameter` recopié dans la config process, sinon segfault |
| La compatibilité est vérifiée sur le **nom** du préréglage machine | la machine est déclarée dans `compatible_printers` |
| Un préréglage machine personnel hérite du profil système | remontée de l'héritage pour retrouver process et filaments |
| La ligne de commande plante en chargeant un projet 3MF | le projet est allégé de ses réglages avant d'être passé |
| Le moteur réarrange le plateau d'office | `--arrange 0` |
| Il refuse les projets plus récents que lui | `--allow-newer-file` |

## Envoi vers le trancheur

Deux gestes distincts sur la sélection, qui marchent aussi sur plusieurs fichiers
à la fois — macOS les transmet ensemble à l'instance déjà lancée.

- **Ouvrir** passe le fichier tel quel : sur un projet, le trancheur proposera de
  l'ouvrir comme projet et remplacera son plateau.
- **Au plateau** envoie une copie **sans les réglages de projet**
  (`project_settings.config`, `slice_info.config`, aperçus de plateau) : le
  trancheur l'importe alors comme simple géométrie, sans toucher au plateau en
  cours ni au profil sélectionné. Les octets de la géométrie ne sont pas
  ré-encodés, donc rien n'est perdu ni déformé.

L'application visée se choisit dans les Réglages parmi les trancheurs détectés
(Snapmaker Orca, OrcaSlicer, Bambu Studio, PrusaSlicer, Cura, Creality Print,
Luban), plutôt que de dépendre du gestionnaire par défaut du système — trois
applications revendiquent le `.3mf` sur une machine typique.

Raccourcis : ⏎ ouvre, ⌘⏎ ajoute au plateau, double-clic ouvre.

## Aperçu G-code

Les fichiers `.gcode`, `.gco`, `.g` et `.nc` apparaissent dans la liste au même
titre que les 3MF, avec un badge qui les distingue.

- **Vignette** : celle que le trancheur a encodée en base64 dans les commentaires
  si elle existe, sinon un rendu des trajectoires calculé par l'application.
- **Métadonnées** lues dans l'en-tête : imprimante, profil, durée estimée, poids
  de filament, nombre de couches.
- **Visualiseur de trajectoires** : couleur par famille (paroi extérieure,
  paroi intérieure, remplissage, pont, support, bordure, tour de purge…),
  **curseur de couches** avec la hauteur Z correspondante, affichage facultatif
  des déplacements à vide, légende des familles présentes.

L'analyseur reconnaît les marqueurs des trois familles de trancheurs : Orca et
Bambu (`;LAYER_CHANGE`, `;TYPE:`), PrusaSlicer et Cura (`;LAYER:`), avec un repli
sur les montées en Z quand aucun marqueur de couche n'est présent. Le cadrage
ignore les déplacements à vide **et la ligne d'amorçage du G-code de démarrage**,
qui traverse tout le plateau et fausserait l'échelle.

## Imprimantes

Gestion d'un parc d'imprimantes et remontée de leur statut en direct. Les
imprimantes sont listées dans la barre latérale, avec un voyant d'état.

- **Ajout manuel** : nom, adresse IP ou nom d'hôte, port, modèle. Le bouton
  « Tester la connexion » interroge l'adresse saisie, corrige le port
  automatiquement (7125 ou 80) et propose le nom d'hôte détecté.
- **Modification** et **suppression** depuis la barre d'outils ou par clic
  droit dans la barre latérale ; la suppression est confirmée par une alerte native.
- **Écran de détail illustré** : la U1 dessinée en perspective — caisson blanc,
  porte vitrée, écran de façade, les quatre têtes alignées sur le dessus, leurs
  tubes et les bobines du flanc gauche — animée par les données réelles.
  La **tête active** est désignée de trois façons : son corps passe en bleu, un
  halo l'entoure et une étiquette « T2 » la surmonte. Chaque tête, chaque tube et
  chaque bobine porte la **couleur du filament chargé**, la pièce sur le plateau
  grandit avec l'avancement dans la couleur employée, les halos de chaleur
  suivent les températures et l'écran de façade change de couleur selon l'état.
  En veille l'illustration se grise.
- **Filaments chargés** : une ligne par emplacement, la tête active en tête de
  liste, avec la matière, la couleur nommée et son code, le vendeur s'il est
  renseigné, les emplacements vides et la température de chaque buse.
- **Statut en temps réel** : l'imprimante pousse ses changements par WebSocket
  (JSON-RPC Moonraker), sans interrogation périodique. État (prête / impression /
  pause / erreur / hors ligne), fichier en cours, progression, couche, temps
  écoulé et restant estimé, filament consommé, température des quatre buses avec
  repérage de la tête active, plateau, ventilateur, facteur de vitesse.
- Les connexions ne vivent que pendant l'affichage de la vue, et sont rétablies
  automatiquement après une coupure (temporisation croissante, 2 s à 20 s).
- Aucune exploration du réseau : seules les adresses saisies sont contactées.

### Protocole

La Snapmaker U1 tourne sous **Klipper + Moonraker** — Snapmaker publie d'ailleurs
son propre fork, [`Snapmaker/u1-moonraker`](https://github.com/Snapmaker/u1-moonraker).
Dans leur OrcaSlicer, l'onglet Device est une application Flutter qui encapsule du
JSON-RPC Moonraker dans une couche MQTT (« WCP »), utile pour le pilotage via le
cloud Snapmaker. En réseau local, l'API HTTP Moonraker suffit et se passe
d'authentification :

| Requête | Usage |
|---|---|
| `GET /server/info` | Moonraker joignable, Klipper connecté |
| `GET /printer/info` | état, nom d'hôte |
| `GET /printer/objects/query?print_stats&display_status&virtual_sdcard&extruder…&heater_bed&toolhead&gcode_move&fan` | impression en cours, températures |
| `GET /api/version` | repli d'identification compatible OctoPrint |
| objet `print_task_config` | bobines chargées (propre à la U1) |
| `ws://…/websocket` | flux temps réel : `printer.objects.list`, puis `printer.objects.subscribe`, puis réception des `notify_status_update` |

Le WebSocket n'envoie que les champs modifiés : l'application maintient un
instantané local et y fusionne chaque mise à jour. L'abonnement ne porte que sur
les objets réellement déclarés par `printer.objects.list`, ce qui évite toute
erreur sur une imprimante mono-buse.

Les bobines chargées viennent de l'objet Klipper **`print_task_config`**, propre à
la U1 : `filament_type`, `filament_color_rgba` (ou `filament_color` en entier
ARGB), `filament_exist`, `filament_sub_type`, `filament_vendor` et
`extruders_used`, un tableau de quatre valeurs par champ. L'abonnement ne le
demande que si `printer.objects.list` le déclare, donc une Klipper ordinaire
n'est pas affectée — ses buses restent alors listées dans le bloc des
températures. Le poids restant n'est pas exposé par la machine.

Moonraker écoute sur le port **7125**, et sur le port **80** derrière le nginx de
l'imprimante. Les quatre têtes de la U1 apparaissent en `extruder`, `extruder1`,
`extruder2` et `extruder3` ; `toolhead.extruder` désigne la tête active.
Le même code fonctionne donc avec n'importe quelle imprimante Klipper.

## Réglages

Une page dédiée, en pied de barre latérale (⌘,). Tout y est enregistré et
retrouvé au lancement suivant. Le thème suit celui du système.

- **Navigation 3D** : action de la molette (zoomer, déplacer ou pivoter),
  inversion du sens, sensibilité réglable
- Inclure les sous-dossiers lors du parcours
- Source de l'aperçu (automatique, plateau, image du modèle, rendu 3D)
- Espace occupé par le cache des vignettes, et vidage

## Raccourcis

Sur macOS, les raccourcis à ⌘ sont ceux de la barre de menus ; sur les autres
systèmes, l'interface les gère elle-même.

| | |
|---|---|
| ⌘O | choisir un dossier |
| ⌘R | actualiser (recharge la page dans la Bibliothèque) |
| ⌘F | rechercher |
| ⌘1 / ⌘2 | vignettes / liste |
| ⌥⌘1 / ⌥⌘2 / ⌥⌘3 | Fichiers / Bibliothèque / IA |
| ⌘, | Réglages |
| ⌘A | tout sélectionner (le texte dans un champ) |
| ⌘-clic / ⇧-clic | ajouter à la sélection / sélectionner une plage |
| ↑ ↓ ← → | naviguer |
| ⏎ | ouvrir dans le slicer |
| ⌘⏎ | ajouter au plateau |
| ⇧⌘R | afficher dans le Finder |
| V | ouvrir la vue 3D (Échap ferme, R recadre) |
| ⌫ ou ⌘⌫ | mettre à la corbeille |

## Utilisation

```sh
cargo tauri dev                 # développement
cargo tauri build --bundles app # produit src-tauri/target/release/bundle/macos/Snap Studio.app
./target/release/snap-studio ~/Downloads   # ouvre directement un dossier
npx @tauri-apps/cli icon src-tauri/app-icon.svg -o src-tauri/icons   # régénère les icônes
```

### Reprise des données de « 3MF Studio »

L'application s'appelait auparavant 3MF Studio (nom technique `trimf`). Au
premier lancement, Snap Studio reprend ses données sans jamais rien écraser :

- **copiés**, l'ancien emplacement restant intact : réglages, favoris et
  imprimantes (`fr.carlini.trimf` → `fr.carlini.snapstudio`), conversations IA
  (`~/.config/trimf` → `~/.config/snap-studio`) et leur historique Claude Code
  (`~/.claude/projects`), stockage WebKit — réglages de l'interface, onglets de
  la Bibliothèque, sessions des sites ;
- **déplacé** : le cache des vignettes et des images de favoris.

Une fois Snap Studio vérifié, les anciens dossiers peuvent être supprimés.

## Organisation

```
ui/                 interface (HTML/CSS/JS, aucune dépendance)
  style.css         jetons du design macOS (clair/sombre, accent) et composants
  app.js            vue Fichiers, barre latérale, barre d'outils, menus, sheets, toasts
  library.js        vue Bibliothèque et favoris
  slice.js          fenêtre de découpe
  viewer.js         visualiseur 3D WebGL2 (matrices, nuanceurs, navigation)
  printers.js       vue Imprimantes, navigation entre les vues
  ia.js             vue IA : conversations, terminal, aperçu
src-tauri/src/
  lib.rs            commandes Tauri + protocole thumb:// servant les vignettes
  menu.rs           barre de menus (macOS) et menus surgissants natifs
  model3mf.rs       conteneur 3MF : métadonnées, choix de la vignette intégrée
  mesh.rs           géométrie 3MF (extension « production » multi-fichiers incluse)
  render.rs         rendu logiciel isométrique avec tampon de profondeur
                    (vignettes) ; le visualiseur interactif, lui, passe par WebGL
  thumbs.rs         génération et cache disque des vignettes
  write3mf.rs       écriture de 3MF : allègement d'un projet, composition d'un plateau
  slicers.rs        détection des trancheurs installés et envoi des fichiers
  library.rs        onglets de navigation, téléchargements, déconnexion
  favorites.rs      prints à faire : magasin, balises og:, vignettes
  presets.rs        inventaire et résolution des préréglages Orca
  slice.rs          découpe en tâche de fond, progression, annulation
  gcode.rs          analyse des trajectoires, couches et métadonnées G-code
  printers.rs       fiches imprimantes (JSON) + client HTTP Moonraker
  watch.rs          flux temps réel WebSocket, une tâche par imprimante
  scan.rs util.rs
```

Le maillage suit le même chemin que les vignettes, via un protocole `mesh://` :
en-tête court, positions en `f32`, une couleur par triangle. Les normales ne sont
pas transportées — le nuanceur les reconstruit par dérivées d'écran, ce qui
divise par deux la taille du tampon et donne l'ombrage à facettes voulu.

Les vignettes sont servies au navigateur via un protocole `thumb://` : les images ne
transitent pas par l'IPC, le webview les charge paresseusement et les met en cache.
