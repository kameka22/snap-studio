# Plan — vue « Préparer » : composer le plateau avant la découpe

Objectif : une vue **Préparer**, à l'image de l'onglet *Prepare* de Snapmaker
Orca : un plateau 3D où l'on ajoute des modèles, les sélectionne, les déplace,
les tourne, les pose sur une face, les met à l'échelle et les dispose, avant
de lancer la découpe — dont l'aperçu, les têtes et l'envoi existent déjà.

Décisions prises :

- option « plateau 3D façon Orca », construite par étapes ;
- nouvelle entrée **Préparer** dans la barre latérale ; dans Fichiers, le
  bouton **Découper** devient **Préparer** ;
- un seul plateau pour l'instant. Un 3MF à plusieurs plateaux s'affiche avec
  son premier plateau sur le plateau, les autres posés à côté, comme dans Orca.

## Point de départ

| Brique | Aujourd'hui | Ce qu'il faut |
|---|---|---|
| Visualiseur (`viewer.js`) | un modèle, fusionné en un bloc de triangles, caméra orbitale | plusieurs objets, chacun avec sa matrice, sélection, déplacement |
| Maillage (`mesh.rs`, `mesh://`) | tout le fichier aplati, toutes les occurrences du `<build>` | un maillage par objet du `<build>`, dans son repère propre |
| Écriture 3MF (`write3mf.rs`) | `write_scene` : plusieurs objets placés, tête par objet ; `write_multipart` | scène = objets placés, pièces multicolores conservées |
| Découpe (`slice.rs`) | un fichier source, recentré d'office (`rewrite_centered`) | une scène : placements gardés tels quels, `--arrange 0` |
| Fichiers | « Découper » ouvre la fenêtre de découpe | « Préparer » ajoute au plateau et ouvre la vue |

**Plusieurs plateaux dans un 3MF** (vérifié dans le code d'Orca,
`PartPlate.cpp`) : les plateaux sont rangés en grille, colonnes =
`ceil(√n)`, pas = taille du plateau × 1,2, rangées vers les Y négatifs ; les
objets sont enregistrés en coordonnées absolues. En gardant ces placements, le
plateau 1 tombe sur notre plateau et les autres se posent à côté, sans calcul.

## Modèle de données

```
Plate
  bed: { w, d }              taille du plateau, lue dans le préréglage machine
  objects: [PlateObject]
PlateObject
  id                          identifiant stable (sélection, annulation)
  name
  source: { path, item }      fichier et rang de l'objet dans son <build>
  pos: [x, y]                 position du centre sur le plateau (mm)
  rot: [rx, ry, rz]           rotations (degrés), appliquées X puis Y puis Z
  scale: [sx, sy, sz]         échelle par axe (uniforme par défaut)
  z: posé automatiquement     le point le plus bas touche le plateau
  plate_hint                  plateau d'origine (1, 2…) pour l'affichage
```

L'état est conservé côté interface et enregistré (JSON, dossier de
configuration) : le plateau survit à un redémarrage. Les maillages, eux, sont
relus depuis les fichiers sources.

## Rust

1. **Objets d'un fichier** — `plate_objects(path)` : un élément par occurrence
   du `<build>` : nom, rang, placement absolu d'origine, boîte englobante,
   nombre de triangles, extrudeurs du modèle, plateau d'origine (lu dans
   `model_settings.config`).
2. **Maillage d'un objet** — `mesh://localhost/o?p=<fichier>&i=<rang>` :
   triangles dans le repère de l'objet, couleur et extrudeur par triangle,
   échantillonnés au-delà d'un budget pour l'affichage. Cache mémoire des
   maillages chargés (dernier fichier utilisé).
3. **Disposition automatique** — `plate_arrange(objets, plateau)` : empreinte
   vue de dessus de chaque objet (enveloppe convexe après rotation), placement
   sur une grille au millimètre, des plus grandes aux plus petites, marge de
   6 mm, rotations de 90° permises. Renvoie les nouvelles positions : le
   résultat se voit tout de suite et s'annule.
4. **Découpe d'une scène** — `slice::Request` reçoit une scène à la place du
   fichier unique : chaque objet est relu en pleine résolution, transformé
   (rotation, échelle, position, posé à Z = 0) et écrit par `write_scene` /
   pièces multicolores comme aujourd'hui. Plus de recentrage : `--arrange 0`.
   Les objets entièrement hors plateau sont écartés (signalé à l'utilisateur).
5. **Enregistrer le plateau** — `plate_save(scène, chemin)` : 3MF de la scène,
   réouvrable dans l'application ou dans Orca (étape 3).

## Interface

**Barre latérale** : *Préparer* entre *Fichiers* et *Bibliothèque*, compteur =
nombre d'objets. Raccourcis ⌥⌘1 à ⌥⌘4 décalés en conséquence.

**Barre d'outils** : titre « Plateau », sous-titre « 3 objets · 1 hors
plateau » ; boutons Ajouter (+, dialogue d'ouverture), Disposer, Poser sur une
face, Dupliquer, Supprimer, puis **Découper** (bouton principal), qui ouvre la
fenêtre de découpe existante avec la scène comme source.

**Scène 3D** (moteur du visualiseur, factorisé) :

- plateau à la taille de la machine choisie, quadrillage 10 mm ;
- clic : sélection (contour accent) ; ⌘-clic : sélection multiple ;
  clic dans le vide : désélection ;
- glisser un objet : déplacement sur le plateau (rayon ∩ plan Z = 0) ;
  glisser dans le vide : orbite ; clic droit / ⇧ : déplacement de la vue ;
- ⌥ + glisser : rotation autour de Z ;
- objet hors plateau : teinte rouge ; chevauchement d'empreintes : contour
  orange (avertissement, comme Orca) ;
- objets des autres plateaux d'un 3MF : posés à côté, atténués, marqués
  « plateau 2 », non découpés tant qu'on ne les ramène pas sur le plateau.

**Inspecteur** (panneau à droite, comme l'aperçu de découpe) :

- liste des objets (sélection, renommage, visibilité) ;
- pour la sélection : position X/Y, rotation X/Y/Z, échelle (% uniforme,
  verrou), dimensions résultantes, extrudeurs du modèle ;
- champs numériques à la façon AppKit, mise à jour en direct.

**Clavier et menus** (barre de menus macOS) : ⌫ supprimer, ⌘D dupliquer,
flèches = 1 mm (⇧ : 10 mm), ⌘Z / ⇧⌘Z annuler / rétablir dans la vue
Préparer, A disposer, F poser sur une face. Menu contextuel natif sur un
objet : dupliquer, supprimer, poser sur une face, centrer, réinitialiser la
rotation.

**Fichiers** : « Découper » devient **Préparer** — le fichier est ajouté au
plateau (placé par la disposition automatique s'il chevauche) et la vue
s'ouvre. « Au plateau », qui envoie au trancheur externe, est renommé
« Au plateau du trancheur » pour lever l'ambiguïté. Le bouton « Découper » de
la vue IA passe aussi par Préparer.

**Annuler / rétablir** : pile d'états du plateau (placements seulement, pas
les maillages), 100 niveaux.

## Étapes

| Étape | Contenu | Utilisable |
|---|---|---|
| 1. Socle | vue Préparer, modèle et sauvegarde du plateau, objets par fichier, maillage par objet, scène multi-objets, sélection, déplacement à la souris, rotation Z, inspecteur, hors plateau, 3MF multi-plateaux, « Préparer » depuis Fichiers, découpe de la scène | composer un plateau et le découper |
| 2. Disposition | disposer automatiquement, chevauchements, dupliquer, supprimer, annuler / rétablir, clavier, menus | plateau de plusieurs pièces sans effort |
| 3. Orientation | voir le détail ci-dessous : socle d'orientation, outil Rotation (anneaux), orientation automatique, poser sur une face, échelle par axe, enregistrer le plateau | l'essentiel de l'onglet Prepare |
| Plus tard | plusieurs plateaux, coloration au pinceau, découpe d'objets, modificateurs, réglages par objet, outils Déplacement et Échelle à poignées | — |

## Étape 3 — orientation, en détail

Ordre de réalisation : chaque sous-étape s'appuie sur la précédente.

### 3.1 Socle d'orientation

Aujourd'hui l'interface ne gère proprement que la rotation autour de Z ; tout
ce qui suit produit des rotations X et Y. Il faut d'abord :

- **objet posé exactement** quand il est basculé : point le plus bas calculé
  sur les sommets du maillage d'affichage (et non plus sur les coins de la
  boîte), mis en cache par rotation ;
- **empreinte exacte** vue de dessus (enveloppe convexe des sommets tournés)
  pour « hors plateau », « chevauche » et la disposition ;
- **inspecteur** : rotations X, Y et Z ; échelle uniforme avec verrou, ou par
  axe (X, Y, Z) ; dimensions résultantes.

La découpe utilise déjà les vrais sommets (`plate.rs`) : rien à changer côté
Rust pour le placement.

### 3.2 Outil Rotation (anneaux), comme la touche R d'Orca

- Trois anneaux autour de la sélection, centrés sur elle, de taille constante
  à l'écran : rouge X, vert Y, bleu Z ; l'anneau survolé s'éclaircit.
- Glisser un anneau : rotation autour de son axe, angle lu dans le plan de
  l'anneau (rayon ∩ plan), angle affiché près du curseur ; ⇧ : pas de 15°.
- L'objet reste posé sur le plateau pendant la rotation ; une rotation
  complète = une étape d'annulation.
- Touche **R** et bouton de barre d'outils pour afficher / masquer l'outil ;
  hors outil, ⌥ + glisser continue de tourner autour de Z.
- Sélection multiple : rotation du groupe autour de son centre.

### 3.3 Orientation automatique, fidèle à « Auto orient » d'Orca

Règles relevées dans `libslic3r/Orient.cpp` et `GUI/Jobs/OrientJob.cpp` :

- **Portée** : **Q** oriente la sélection, ou tous les objets si rien n'est
  sélectionné ; **⇧Q** oriente tout le plateau. Seule la bascule (X / Y) est
  calculée ; la rotation autour de Z est gardée ; l'objet est reposé, pas
  déplacé.
- **Seuil de surplomb** : `support_threshold_angle` du profil d'impression
  (30° à défaut ou si 0). Une face tournée vers le bas, inclinée de moins que
  le seuil sur l'horizontale, demande du support.
- **Candidats** (direction envoyée vers le bas) : l'orientation actuelle ; les
  10 directions de faces de plus grande surface cumulée (normales regroupées
  au millième) ; les 14 de l'enveloppe convexe 3D ; 18 directions fixes (axes
  et inclinaisons à 45°) ; doublons retirés.
- **Mesures** pour chaque candidat, première couche = 0,2 mm :
  surplomb *S* (faces vers le bas au-delà du seuil, hors première couche) ;
  appui *A* (faces dans la première couche : moitié entre 0 et 0,2 mm, entière
  sous 0,1 mm) ; contour *C* = 4·√A ; appui de l'enveloppe *H* ; faces presque
  plates *L* (1,4° à 14°, au-dessus de la première couche).
- **Coût** (mode par défaut d'Orca, « optimiser la surface d'interface des
  supports ») :
  `20 × (0,1·S + 1 + 0,001·L) / (1 + 0,5·C + 2,5·A + 0,1·H)`, plus 100 si
  l'appui est inférieur à 0,1 mm². Le plus petit l'emporte ; à égalité,
  l'orientation d'origine est gardée.
- **Différence assumée** : Orca pénalise davantage le support sur les faces
  marquées « apparence » ; nos fichiers ne portent pas cette marque.

Mise en œuvre :

- Rust, module `orient.rs` : enveloppe convexe 3D (quickhull), candidats,
  mesures, coût ; calcul sur le maillage pleine résolution (réduit à environ
  200 000 triangles au-delà) ; renvoie les rotations X / Y / Z en conservant
  la rotation Z choisie par l'utilisateur.
- Commande `plate_orient(objets, seuil)` ; le seuil vient du profil
  d'impression mémorisé (lecture du préréglage côté Rust).
- Interface : bouton « Orienter automatiquement » (barre d'outils, menu
  contextuel), touches Q / ⇧Q, progression pour plusieurs objets ou de gros
  maillages, une étape d'annulation.
- Tests Rust : un « L » couché reste couché ; une pyramide posée sur sa pointe
  se retourne sur sa base ; un cube déjà posé ne bouge pas (égalité → origine).

### 3.4 Poser sur une face

Mode « Poser sur une face » (touche **F**, bouton) : survol = face mise en
évidence, clic = rotation qui amène sa normale vers le bas, objet reposé. Même
mécanique que l'orientation automatique (alignement d'une direction sur −Z).

### 3.5 Échelle par axe et enregistrement du plateau

- Échelle par axe dans l'inspecteur (3.1), verrou d'homothétie par défaut.
- **Enregistrer le plateau** : 3MF de la scène (placements appliqués, pièces
  et têtes conservées), réouvrable dans l'application et dans Orca.

### Plus tard

Outils à poignées **Déplacement** (M) et **Échelle** (S) d'Orca : peu utiles
tant que l'objet se glisse sur le plateau et que l'échelle se règle dans
l'inspecteur ; à reconsidérer à l'usage.

## Tests

- Rust : orientation automatique sur des formes connues (voir 3.3).
- Rust : objets d'un 3MF (y compris multi-plateaux), maillage par objet,
  disposition (aucun recouvrement, tout dans le plateau), écriture d'une scène
  relue avec les bons placements, objets hors plateau écartés.
- Interface (backend simulé) : ajout depuis Fichiers, sélection, déplacement,
  inspecteur, annulation, découpe de la scène (requête envoyée).
- Sur machine : découpe réelle d'une scène de plusieurs objets tournés,
  placements respectés dans le G-code ; 3MF Bambu multi-plateaux réel.

## Risques

| Point | Parade |
|---|---|
| Gros maillages en scène | maillage d'affichage échantillonné ; pleine résolution relue seulement pour la découpe |
| Sélection précise sur des pièces fines | lancer de rayon sur les triangles de l'objet, après un tri par boîte englobante |
| Convention de placement des 3MF Bambu multi-plateaux | vérification sur un vrai fichier dès l'étape 1 |
| Le moteur repose les objets sur le plateau ou les déplace | `--arrange 0`, objets déjà posés à Z = 0 ; test de découpe réelle |
| Couleurs du modèle de plusieurs fichiers | association aux têtes par couple (fichier, extrudeur) dans la fenêtre de découpe |

## État

- Étape 1 (socle) : faite.
- Étape 2 (disposition) : faite. Écart au plan : la disposition est calculée
  dans l'interface (empreintes déjà connues, résultat sans aller-retour), même
  algorithme que prévu.
- Étape 3 (orientation) : faite (3.1 à 3.5). Enveloppe convexe 3D écrite à la main (quickhull, testée : points intérieurs, Euler, orientation des faces ; 40 000 sommets en 0,26 s).
