# Plan — découpe avec aperçu, filaments de l'imprimante, envoi à l'impression

Objectif : faire de la fenêtre de découpe un vrai flux « Snapmaker Orca » :
choisir l'imprimante et ses bobines, découper, **prévisualiser** le résultat
avec ses temps et consommations, puis l'**enregistrer** ou l'**envoyer** à
l'imprimante avec les options de lancement.

## État actuel

| Étape | Aujourd'hui |
|---|---|
| Fenêtre de découpe | préréglage machine, profil, **un** filament (dupliqué sur les 4 têtes), 5 réglages rapides |
| Préparation (`presets::prepare`) | configs machine / process / filaments écrites dans un dossier de travail |
| Géométrie (`slice::rewrite_centered`) | **fusionnée en un seul objet, sans extrudeur** : un modèle multicolore sort monocolore |
| Moteur | CLI Snapmaker Orca `--slice 0`, aucun retour d'avancement (compteur de secondes côté interface) |
| Résultat | G-code **copié aussitôt** à côté du modèle, puis ouvert dans le visualiseur |
| Visualiseur (`gcode.rs`, `viewer.js`) | couches, légende par trajectoire, déplacements ; durée, poids et couches lus dans les commentaires |
| Imprimante (`printers.rs`) | `printer_status` lit d'un coup les bobines (`print_task_config`) ; **aucun envoi** de fichier ni de commande |

## Ce que révèle Snapmaker Orca (clone `OrcaSlicer/`)

- **Avancement réel** : la CLI accepte `--pipe <tube nommé>` et y écrit des
  lignes JSON `{plate_percent, total_percent, message}`.
- **Statistiques** : `result.json` ne donne ni temps ni poids ; tout est dans
  les commentaires du G-code (temps total, première couche, filament par
  extrudeur en mm / cm³ / g, coût).
- **Envoi** : téléversement Moonraker standard, `POST /server/files/upload`
  avec `print=true`.
- **Options de lancement** de la U1, réglées *avant* l'impression par des
  macros Klipper, envoyées comme G-code (`printer.gcode.script`) :

  | Firmware | Commandes |
  |---|---|
  | ≥ 1.3.0 | `SET_PRINT_PREFERENCE KEY=auto_bed_leveling VALUE=false` — une ligne par option |
  | < 1.3.0 | `SET_PRINT_PREFERENCES AUTO_BED_LEVELING=false FLOW_CALIBRATE=false TIME_LAPSE_CAMERA=false` |
  | les deux | `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=<outil G-code> MAP_EXTRUDER=<tête>` par outil, puis `SET_PRINT_USED_EXTRUDERS EXTRUDERS=<liste>` |

  Clés : `auto_bed_leveling` (nivellement auto), `flow_calibrate` (calibration
  du débit d'extrusion), `time_lapse_camera` (timelapse). Elles se relisent
  dans `print_task_config`, ce qui permet de vérifier qu'elles ont été prises.

## Parcours cible

1. **Fenêtre de découpe** : imprimante enregistrée (ou « sans imprimante »)
   → préréglage machine déduit → 4 têtes avec bobine réelle et préréglage
   filament choisi automatiquement → association des couleurs du modèle aux
   têtes → profil et réglages rapides → **Découper**, barre d'avancement réelle.
2. **Aperçu** dans le visualiseur plein écran, panneau latéral : temps total
   et première couche, filament par tête (g, m, coût), répartition du temps
   par type de trajectoire, temps cumulé à la couche visée ; coloration par
   trajectoire ou par filament.
3. Actions : **Envoyer à l'imprimante…**, **Enregistrer le G-code**,
   **Modifier les réglages** (retour à la fenêtre, choix conservés),
   **Fermer** (l'aperçu temporaire est supprimé).
4. **Envoi** : sheet avec les trois options, **toutes décochées par défaut** —
   Nivellement automatique du plateau, Calibration du débit d'extrusion,
   Caméra timelapse — puis préparation, téléversement avec progression,
   lancement, retour vers l'écran de l'imprimante.

## Phases

### 1. Découpe en aperçu
- `slice.rs` : le travail se termine en phase `preview` (G-code laissé dans le
  dossier temporaire, statistiques jointes) ; nouvelles commandes
  `slice_save(job, dest?)` et `slice_discard(job)` ; nettoyage des aperçus
  orphelins au démarrage.
- Avancement réel via `--pipe` (tube nommé créé par le Rust, lu dans un fil).
- `viewer.js` : mode aperçu (panneau, boutons), réouverture de la fenêtre avec
  les mêmes choix.

### 2. Statistiques détaillées
- `gcode.rs` : filament par extrudeur (g, m, cm³), coût, temps de première
  couche, suivi des vitesses `F` et des `M73`.
- Temps par couche : `M73` s'ils sont émis par le profil U1, sinon calcul.
- Temps par type de trajectoire : longueur ÷ vitesse, ramené au temps total
  d'Orca — affiché comme une estimation (« ≈ »).
- Coloration de l'aperçu par filament (`Seg.tool` + couleurs des têtes).

### 3. Imprimante et bobines dans la fenêtre de découpe
- Choix d'une imprimante enregistrée ; `printer_status` lu à l'ouverture.
- Préréglage machine déduit du modèle de l'imprimante (modifiable).
- Préréglage filament par tête : type obligatoire, puis fabricant, puis
  sous-type, repli sur le générique ; couleur réelle reportée dans
  `filament_colour`. Tête vide ou type inconnu signalés.
- `Request.filaments` : un préréglage par tête (aujourd'hui un seul, dupliqué).
- Mémoire des choix par imprimante (comme aujourd'hui par machine).

### 4. Multicolore
- `rewrite_centered` : une `SceneObject` par matériau / objet, chacune avec son
  extrudeur, au lieu d'un bloc unique.
- Association filaments du modèle → têtes : par type, puis couleur la plus
  proche (façon mappage AMS), corrigeable dans la fenêtre.
- Limite assumée : la coloration au pinceau (peinture par triangle) n'est pas
  lue par notre chargeur de maillage ; ces modèles restent monocolores.

### 5. Envoi à l'imprimante
- `printers.rs` : `gcode_script(printer, script)`, `upload(printer, file,
  progress)` (multipart Moonraker, fonctionnalité `multipart` de `reqwest`),
  `start_print(printer, filename)`.
- Commande `print_send` : refuse si l'imprimante imprime déjà ; envoie la
  correspondance des têtes, les têtes utilisées et les trois options (forme
  ≥ 1.3.0, repli sur la forme ancienne si la macro est inconnue) ; relit
  `print_task_config` pour vérifier ; téléverse avec progression ; lance.
- Sheet d'envoi : imprimante, état, les trois cases décochées, progression,
  erreurs lisibles ; à la fin, bascule vers la vue Imprimantes.

## Risques et vérifications sur machine

| Point | Vérification |
|---|---|
| Format des valeurs (`true`/`false` vs `1`/`0`) | relire `print_task_config` après envoi |
| Détection du firmware ≥ 1.3.0 | repli automatique sur l'ancienne macro en cas d'erreur « commande inconnue » |
| `M73` dans le profil U1 | sinon temps par couche calculé |
| Tube nommé `--pipe` sous macOS | repli sur le compteur si le moteur ne s'y connecte pas |
| Le moteur accepte plusieurs objets à extrudeurs distincts dans notre 3MF réécrit | test de découpe réel (déjà en place dans `presets.rs`) |
| Envoyer une impression est une action physique | refus si l'imprimante n'est pas au repos ; confirmation explicite dans la sheet |

## État

Les cinq phases sont implémentées (Rust, interface, tests). Vérifié dans le bac à
sable : compilation Linux et macOS, tests unitaires (statistiques G-code,
progression du moteur, extrudeurs du modèle, réécriture multipièce relue,
script de préparation), parcours complet de l'interface sur un backend simulé.

À vérifier sur machine (moteur et U1 réels) :

- `cargo test multicolor_job_uses_two_heads` : découpe bicolore réelle ;
- avancement par `--pipe` pendant une vraie découpe ;
- envoi : options relues dans `print_task_config`, lancement de l'impression.
