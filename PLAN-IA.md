# Onglet IA — plan d'implémentation

Modifier un objet 3D en discutant avec Claude Code, et voir la pièce changer à
l'écran pendant qu'il travaille.

L'onglet **IA** prend place entre *Fichiers* et *Imprimante*. Une conversation
est attachée à un objet. Le volet central est un **vrai terminal** où tourne
Claude Code ; le volet de droite affiche l'objet dans son état courant et le
renvoie dans vos fichiers quand il vous convient.

---

## 1. Décisions déjà prises

| Sujet | Choix | Raison |
|---|---|---|
| Moteur de modelage | **Python + trimesh + manifold3d** | Léger, robuste sur les booléens, bien connu de Claude. Blender écarté pour l'instant. |
| Aperçus visuels | **Notre rastériseur `render.rs`** | Déjà écrit, sans GPU ni OpenGL. Claude lit les PNG et voit son travail. |
| Conversation | **Terminal embarqué (pseudo-terminal)** | Le vrai outil : mode plan, commandes slash, `@fichier`, permissions, interruption. |
| Format d'échange | **STL** dans l'espace de travail | Ce que les outils Python manipulent le mieux ; conversion aux deux bouts par l'application. |
| Emplacement | **`~/.config/snap-studio/ia/`** | Monté tel quel dans le conteneur, et sans espace dans le chemin. |
| Bac à sable | **yolobox si Docker est là, sinon local** | Le lanceur est interchangeable ; on peut travailler dès aujourd'hui sans Docker. |

---

## 2. Sur le disque

```
~/.config/snap-studio/ia/
└── 7f3a…-uuid/                 ← le dossier ET l'identifiant de session Claude
    ├── meta.json
    ├── .yolobox.toml           image personnalisée : python, trimesh, manifold3d
    └── workspace/              ← monté dans le conteneur
        ├── CLAUDE.md           consignes, conventions de sortie, outils dispo
        ├── source.stl          copie convertie de l'objet d'origine
        ├── outils/
        │   ├── mesure.py       dimensions, volume, étanchéité, nombre de faces
        │   └── exporter.py     valide et écrit out/current.stl
        ├── out/
        │   ├── current.stl     ce que l'application affiche en direct
        │   └── apercu-*.png    trois vues, écrites par l'application
        └── versions/
            ├── v1.stl
            └── v2.stl
```

`meta.json` :

```json
{
  "id": "7f3a…",
  "titre": "Support de téléphone — angle 15°",
  "source": "/Users/…/support-v2.3mf",
  "cree_le": 1758600000,
  "modifie_le": 1758600420,
  "moteur": "conteneur",
  "version": 3,
  "enregistre": null
}
```

**Un seul identifiant** sert de nom de dossier et de `--session-id` Claude. La
reprise devient déterministe : plus besoin de fouiller l'historique de Claude ni
de deviner quoi que ce soit.

---

## 3. Code à écrire

### Nouveaux modules Rust

| Fichier | Rôle |
|---|---|
| `src-tauri/src/ia.rs` | Le magasin des conversations : création, liste, suppression, préparation de l'espace de travail, versions, enregistrement dans Fichiers. |
| `src-tauri/src/pty.rs` | Les pseudo-terminaux : ouverture, lecture continue, écriture, redimensionnement, fin de vie. Contient le lanceur `Local` / `Yolobox`. |
| `src-tauri/src/stl.rs` | Lecture et écriture STL, binaire et ASCII. |

### Interface

| Fichier | Rôle |
|---|---|
| `ui/ia.js` | Liste des conversations, écran de détail, terminal, volet 3D. |
| `ui/vendor/xterm.js` + `.css` | Émulateur de terminal, déposé tel quel — pas de npm, comme le reste du projet. |

La politique de sécurité actuelle (`script-src 'self'`, `style-src 'self'
'unsafe-inline'`) l'autorise déjà : **rien à modifier dans `tauri.conf.json`**.

### Dépendances à ajouter

```toml
portable-pty = "0.9"   # pseudo-terminaux, multi-plateforme
notify = "8"           # surveillance du dossier de travail
uuid  = { version = "1", features = ["v4"] }
```

Pas de `base64` : on ajoute un `b64_encode` d'une vingtaine de lignes dans
`util.rs`, en miroir du `b64_decode` qui existe déjà dans `gcode.rs`.

### Commandes exposées

```
ia_engine()                      → { docker, yolobox, claude } : ce qui est installé
ia_list()                        → [Conversation]
ia_create(source, titre?)        → Conversation   (prépare l'espace de travail)
ia_delete(id)
ia_versions(id)                  → [Version]
ia_revert(id, n)                 remet la version n dans out/current.stl
ia_save(id, dossier)             → chemin du 3MF écrit
pty_open(id, cols, rows)
pty_write(id, data)
pty_resize(id, cols, rows)
pty_close(id)
```

Évènements poussés vers l'interface :

```
ia-pty   { id, b64 }        octets du terminal
ia-exit  { id, code }       le processus s'est terminé
ia-mesh  { id, version }    l'objet a changé, le volet 3D se recharge
```

---

## 4. Les étapes

### Étape 1 — L'aller-retour STL · 0,5 j · **fait**

Tout le reste en dépend, donc on commence par là.

- `stl.rs` : lecture binaire et ASCII, écriture binaire.
- `ia.rs` : `3mf → source.stl` en s'appuyant sur `mesh::load_mesh` ;
  `out/current.stl → 3mf` en s'appuyant sur `write3mf::write_scene`.
- Extension du protocole `mesh://` pour servir aussi un `.stl` — simple aiguillage
  sur l'extension.

**Terminé quand** un 3MF part en STL et revient en 3MF avec le même nombre de
triangles et la même boîte englobante, vérifié par un test.

### Étape 2 — Le magasin et la création · 0,5 j · **fait**

- `meta.json`, écriture atomique par fichier temporaire puis renommage, comme
  `favorites.rs`.
- `ia_create` : dossier, `CLAUDE.md`, `outils/`, conversion de la source,
  première version. Le `.yolobox.toml` est reporté à l'étape 7 : mieux vaut
  l'écrire une fois son format vérifié que le deviner.
- Écran Fichiers : bouton **Modifier avec l'IA**, grisé pour un G-code et pour
  une sélection multiple.
- Modale de départ avec la demande initiale et le choix du bac à sable.
- Écran liste avec vignette, statut, date.

**Terminé quand** le bouton crée un dossier complet et que la conversation
apparaît dans la liste.

### Étape 3 — Le terminal embarqué · 1,5 j · **fait**

Le gros morceau.

- `pty.rs` : `portable-pty`, un fil de lecture par terminal qui pousse les octets
  en base64 vers l'interface. `TERM=xterm-256color`.
- Le lanceur, deux variantes seulement par leur ligne de commande :
  - local : `claude --session-id <uuid> --dangerously-skip-permissions`
  - conteneur : `yolobox claude --claude-config -- --session-id <uuid> …`
  - réouverture : `--resume <uuid>` à la place de `--session-id`.
- Côté interface : xterm.js, frappes vers `pty_write`, redimensionnement de la
  fenêtre vers `pty_resize`.
- **Octets bruts jusqu'à l'émulateur** : xterm.js accepte un `Uint8Array` et
  recolle lui-même un « é » coupé entre deux paquets. Décoder en chemin aurait
  donné des losanges noirs.
- Le terminal reste vivant quand on quitte l'onglet ; on le cache, on ne le
  détruit pas.

**Terminé quand** on ouvre une conversation, qu'on discute avec Claude, qu'on
quitte l'onglet et qu'on revient sans rien perdre — puis qu'on relance
l'application et que `--resume` retrouve le fil.

### Étape 4 — Le volet 3D vivant · 0,75 j · **fait**

- Surveillance de `out/` avec `notify`, temporisation de 300 ms pour ne pas
  recharger pendant l'écriture. Mesuré : le système signale une écriture en
  12 ms, donc l'objet se rafraîchit environ un tiers de seconde après Claude.
- Rechargement du visualiseur, et **capture d'une version** à chaque objet stable.
- Frise des versions, retour en arrière.
- Encart d'informations : dimensions, masse estimée, étanchéité, nombre de faces.
- Le visualiseur existant est **déplacé** dans le volet plutôt que dupliqué :
  même contexte graphique, aucune divergence possible entre les deux vues.

**Terminé quand** Claude écrit un fichier et que la pièce change à l'écran sans
qu'on touche à rien.

### Étape 5 — Le retour dans le circuit · 0,25 j · **fait**

- **Enregistrer dans Fichiers** : conversion en 3MF, nom dérivé de la source
  (`support-v2-ia.3mf`), rafraîchissement de la galerie, vignette automatique.
- **Découper** : enchaîne sur la modale de découpe existante.
- La conversation passe en ✓ et `meta.json` retient le chemin écrit.

**Terminé quand** un objet modifié se retrouve dans vos fichiers puis part en
G-code sans quitter l'application.

### Étape 6 — La boîte à outils de Claude · 0,5 j · **fait**

C'est peu de code et c'est ce qui fait la différence entre un gadget et un outil.

- `CLAUDE.md` : l'objet, les unités, où écrire, comment vérifier, quoi ne pas faire.
- `mesure.py` et `exporter.py`, avec un refus clair si le maillage n'est pas étanche.
- **Les aperçus** : à chaque changement, l'application rend trois vues PNG dans
  `apercu/` — hors du dossier surveillé, pour ne pas se réveiller elle-même.
  Deux réglages trouvés à l'œil : la vue de dessus est inclinée de vingt degrés,
  sans quoi le relief disparaît, et les rendus sont posés sur un fond sombre,
  sans quoi une pièce claire s'évanouit.
- Consignes, outils et aperçus sont **remis à niveau à chaque ouverture** : une
  conversation ancienne ne doit pas travailler avec un mode d'emploi périmé.

**Terminé quand** Claude corrige de lui-même un trou mal placé après avoir
regardé le rendu.

### Étape 7 — Le conteneur · 0,5 j · **fait**

- `ia_engine()` : détection de Docker, **du démon**, de yolobox et de claude.
  Installé ne veut pas dire démarré, et c'était le cas au moment de l'étape.
- Fragment de Dockerfile engendré par l'application, partagé par toutes les
  conversations pour ne construire l'image qu'une fois. L'installation se fait
  en administrateur : le dossier personnel du conteneur est recouvert par un
  volume à l'exécution, et tout ce qui y serait posé disparaîtrait.
- Écran « le bac à sable n'est pas prêt » avec le repli en mode local.
- Ligne d'attente dans le terminal pendant le démarrage du conteneur.

**Terminé quand** la même conversation fonctionne des deux côtés, au préfixe de
commande près.

### Finitions · 0,5 j

Réglages (bac à sable par défaut, garder le conteneur chaud), bouton *Ouvrir dans
un vrai terminal*, renommage d'une conversation, suppression avec son dossier,
section README.

---

## 5. Ce qui sera testé

| Test | Objet |
|---|---|
| `stl::round_trip` | cube écrit puis relu : mêmes triangles, même boîte |
| `stl::ascii_et_binaire` | les deux dialectes se lisent |
| `ia::store_round_trip` | création, liste, suppression, restauration de l'état |
| `ia::prepare_workspace` | le dossier contient tout ce qu'il faut |
| `pty::argv` | la ligne de commande produite pour chaque lanceur et chaque mode |
| `pty::smoke` | un terminal sur `/bin/echo`, on relit ce qui est écrit |
| `util::b64` | encodage et décodage réciproques |
| `ia::versions` | une écriture crée une version, le retour arrière la restaure |

---

## 6. Risques et parades

**Caractères coupés.** Une lecture peut trancher un caractère accentué en deux.
Parade : base64 sur le fil, `TextDecoder` en mode flux à l'arrivée.

**Redimensionnement.** L'interface de Claude Code redessine selon la largeur ;
sans `pty_resize` l'affichage se brouille. Parade : relier le redimensionnement
dès l'étape 3, pas après.

**Tempête d'écritures.** Un script qui écrit par morceaux déclencherait dix
rechargements. Parade : temporisation, et on ne charge que si la taille du
fichier est stable.

**Docker absent.** C'est le cas aujourd'hui sur cette machine. Parade : le mode
local, disponible dès l'étape 3.

**3MF riche.** Plusieurs objets ou plusieurs couleurs ne survivent pas au passage
par STL. Parade : on fusionne, et on **prévient clairement** à la création.

**Gros maillages.** `mesh::load_mesh` échantillonne au-delà d'un budget, ce qui
est bon pour l'affichage mais faux pour un export. Parade : la conversion vers
STL lit sans budget ; seul l'affichage échantillonne.

---

## 7. Hors périmètre

Blender, le pont MCP et ses outils applicatifs, le plateau éditable, la
préservation des couleurs et des objets multiples, et toute modification de
G-code. Aucun de ces points n'est fermé — ils viendront après.

---

## 8. Récapitulatif

| Étape | Durée |
|---|---|
| 1 · Aller-retour STL | 0,5 j |
| 2 · Magasin et création | 0,5 j |
| 3 · Terminal embarqué | 1,5 j |
| 4 · Volet 3D vivant | 0,75 j |
| 5 · Retour dans le circuit | 0,25 j |
| 6 · Boîte à outils | 0,5 j |
| 7 · Conteneur | 0,5 j |
| Finitions | 0,5 j |
| **Total** | **5 j** |

Les étapes 1 à 5 — **3,5 jours** — suffisent à une utilisation réelle en mode
local, sans rien installer.
