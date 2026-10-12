# Plan — assistant de bienvenue et recherche des imprimantes sur le réseau

Objectif : au premier lancement, un assistant en quatre étapes accueille
l'utilisateur, lui fait choisir son dossier de modèles et trouver sa U1 sur le
réseau (ou la saisir à la main), puis le lâche dans l'application. La
recherche réseau sert aussi, ensuite, dans « Ajouter une imprimante ».

**État : implémenté.** Décisions retenues : pas de balayage du sous-réseau
pour l'instant, Snapmaker Orca vérifié dans le récapitulatif, assistant au
premier lancement seulement, confettis et fusée. Reste le test réel avec une
U1 (étape 6).

## Partie A — recherche des imprimantes (mDNS)

### Ce que fait Snapmaker Orca (`SSWCP.cpp`)

- Chaque U1 s'annonce en **mDNS / Bonjour** sous `_snapmaker._tcp.local`,
  avec une fiche TXT : `sn` (numéro de série), `device_name`, `machine_type`,
  `version`, `ip`, `link_mode`, `region`.
- Orca envoie d'abord une requête de réveil `_services._dns-sd._udp` (~8 s) :
  certains routeurs Wi-Fi ne relaient le multicast qu'après en avoir vu
  passer. Puis il écoute `_snapmaker` jusqu'à 20 s, une entrée par `sn`.

### Côté Rust — `discover.rs`

- Crate `mdns-sd` (Rust pur, macOS / Windows / Linux, sans dépendance
  système).
- Commandes :
  - `printer_discover_start` : réveil, puis écoute de `_snapmaker._tcp` et
    `_moonraker._tcp` (autres Klipper) pendant 20 s ;
  - `printer_discover_stop` : arrêt (fenêtre fermée, étape quittée).
- Chaque imprimante trouvée part aussitôt vers l'interface (événement
  `printer-found`) : `{ sn, name, model, ip, firmware, service }`, IPv4
  seulement, dédoublonnée par numéro de série (à défaut par IP). Fin de
  recherche : événement `printer-discover-done`.
- Journal des réponses reçues (pour diagnostiquer une U1 qui n'apparaît pas).

### macOS — `Info.plist`

- `NSLocalNetworkUsageDescription` : « Snap Studio recherche les imprimantes
  Snapmaker de votre réseau local. »
- `NSBonjourServices` : `_snapmaker._tcp`, `_moonraker._tcp`.

Sans ces clés, macOS bloque la recherche sans rien dire. Au premier usage, il
demande l'autorisation « trouver des appareils sur le réseau local ».

### Interface — un composant partagé

`discoveryList(conteneur, { onPick })` dans `printers.js`, utilisé par
l'assistant et par la fenêtre « Ajouter une imprimante » :

- en-tête « Sur le réseau » avec indicateur de recherche, bouton
  « Relancer » une fois terminé ;
- une ligne par imprimante, au fil des réponses : icône U1, nom, IP, modèle,
  firmware ; « déjà ajoutée » pour une imprimante enregistrée (même `sn` ou
  même IP) ;
- clic : remplit nom, adresse, modèle, puis lance le test de connexion
  existant (`printer_probe`), qui trouve le bon port Moonraker (7125 ou 80) ;
- rien trouvé au bout de 20 s : « Aucune imprimante trouvée — vérifiez qu'elle
  est allumée et sur le même réseau, ou saisissez son adresse ».

La fenêtre « Ajouter une imprimante » affiche cette liste au-dessus du
formulaire ; la saisie manuelle reste en dessous, inchangée.

### Limites

- Le mDNS ne traverse pas les routeurs : une imprimante sur un autre
  sous-réseau ou VLAN n'apparaît pas.
- Wi-Fi invité / isolation des clients : bloqué. Reste la saisie manuelle.
- La recherche ne se lance qu'à l'affichage de la liste, jamais en
  arrière-plan.

## Partie B — assistant de bienvenue

### Quand il s'affiche

- **Premier lancement** : aucune trace `snapstudio.welcome` **et** aucun
  dossier ni imprimante connus. Un utilisateur existant (ou repris de
  3MF Studio) ne le voit donc pas.
- **À la demande** : Réglages → Application → « Revoir l'accueil », et menu
  Aide → « Assistant de bienvenue ».
- Terminé ou ignoré : `snapstudio.welcome = { done: true, version }`.

### Forme

Plein écran dans la fenêtre, au-dessus de l'application (pas une feuille
modale) : fond translucide (vibrancy), carte centrée de ~560 px, indicateur
d'étapes (quatre points) en bas, transitions en glissé horizontal. Lien
discret « Ignorer » en haut à droite, sauf à la dernière étape. Clavier : ⏎
continue, ⌘[ / ← revient en arrière.

### Les étapes

**1. Bienvenue**
- Icône de l'application en grand, légère animation d'entrée.
- « Bienvenue dans Snap Studio » ; « Merci d'utiliser Snap Studio ! » et une
  phrase sur ce qu'il fait.
- Trois points forts avec icônes : explorer ses modèles, préparer et
  découper, suivre ses impressions.
- Bouton **Continuer**.

**2. Vos modèles**
- « Où rangez-vous vos fichiers 3MF ? »
- Raccourcis proposés (`quick_places` : Téléchargements, Documents,
  Bureau…) et **Choisir un dossier…** (sélecteur natif).
- Une fois choisi : chemin affiché et nombre de fichiers 3MF / G-code
  trouvés (« 42 modèles »), coche verte.
- **Continuer** (actif quand un dossier est choisi) ou **Passer**.

**3. Votre imprimante**
- « Trouvons votre Snapmaker U1 » ; la recherche démarre à l'arrivée sur
  l'étape (composant de la partie A).
- Clic sur une imprimante trouvée → test de connexion → carte de
  confirmation : nom (modifiable), IP, état (« prête », « en impression »…),
  bouton **Ajouter**. Plusieurs imprimantes peuvent être ajoutées.
- **Saisir l'adresse manuellement** : déplie le formulaire (adresse, port,
  nom, **Tester**), le même que la fenêtre d'ajout.
- **Continuer** ou **Passer**.

**4. Tout est prêt**
- Illustration animée : l'icône de l'application qui apparaît avec un éclat
  de confettis aux couleurs des quatre têtes de la U1 (bleu, orange, vert,
  violet), une seule fois, respectant « Réduire les animations ».
- Récapitulatif avec coches : dossier choisi, imprimante(s) ajoutée(s),
  **Snapmaker Orca détecté** (sinon : « Installez Snapmaker Orca pour
  découper » avec lien de téléchargement).
- Gros bouton **Commencer** avec une icône fusée.
- À la fin : l'assistant s'efface en fondu, l'application s'ouvre sur
  Fichiers avec le dossier choisi (ou sur Imprimantes si seul ce pas a été
  fait).

### Fichiers

| Fichier | Contenu |
|---|---|
| `src-tauri/src/discover.rs` | recherche mDNS, commandes, événements |
| `src-tauri/src/lib.rs`, `Cargo.toml` | enregistrement, crate `mdns-sd` |
| `src-tauri/Info.plist` | autorisation réseau local, services Bonjour |
| `src-tauri/src/menu.rs` | Aide → Assistant de bienvenue |
| `ui/welcome.js` | assistant : étapes, navigation, premier lancement |
| `ui/printers.js` | composant `discoveryList`, fenêtre d'ajout |
| `ui/index.html`, `ui/style.css` | structure et style de l'assistant |
| `README.md` | premier lancement, recherche réseau |

## Étapes de réalisation

1. Recherche mDNS (Rust) + journal, commandes et événements.
2. Composant `discoveryList` dans « Ajouter une imprimante ».
3. Assistant : structure, navigation, étapes 1 et 2.
4. Étape 3 (imprimante) avec le composant.
5. Étape 4 (récapitulatif, animation, Commencer), premier lancement,
   « Revoir l'accueil ».
6. Vérification : rendu des quatre étapes en clair et sombre (navigateur
   sans affichage, recherche simulée), puis test réel chez toi avec la U1.

## Décisions à prendre

| Question | Recommandation |
|---|---|
| Repli par balayage du sous-réseau (port 7125) si le mDNS ne trouve rien ? | **Non pour l'instant** ; à ajouter si ta U1 n'apparaît pas en mDNS. |
| Vérifier Snapmaker Orca dans le récapitulatif ? | **Oui**, informatif : la découpe en dépend. |
| Assistant pour les utilisateurs existants ? | **Non** ; accessible depuis les Réglages et le menu Aide. |
| Animation finale | **Icône + confettis aux couleurs des têtes**, bouton avec fusée. |
