# Plan — builds macOS / Windows / Linux et mises à jour automatiques

Objectif : publier Snap Studio pour les trois systèmes, à la demande, et que
l'application installée propose elle-même les nouvelles versions : elle les
télécharge, vérifie qu'elles viennent bien de nous, s'installe et redémarre.
Outil : le plugin officiel `tauri-plugin-updater`.

**État : implémenté** (étapes 2 à 5). Reste à valider sur de vraies releases
(étape 6) et à confirmer les emplacements de Snapmaker Orca sous Windows et
Linux.

Décisions prises :

- **releases déclenchées uniquement par `scripts/release.sh`** (plus de build
  à chaque push) ;
- **vérification au lancement et sur bouton** ;
- **nouvelle version → modale à l'ouverture**, qui propose l'installation ;
  dans les Réglages : version installée, informations, bouton de vérification
  et case pour activer la vérification au lancement ;
- **builds macOS, Windows et Linux**.

## Principe

```
scripts/release.sh → CI                       App installée
───────────────────────                       ─────────────────────────────
build + signature (clé privée)                au lancement / sur bouton :
  ├─ macOS   Snap Studio.app.tar.gz + .sig    lit latest.json sur GitHub
  ├─ Windows Snap-Studio_setup.exe + .sig     version annoncée > la sienne ?
  ├─ Linux   Snap-Studio.AppImage + .sig      → modale : notes, Installer
  └─ latest.json (version, notes,             → télécharge, vérifie la signature
     URL + signature par plateforme)             (clé publique intégrée)
release GitHub v0.1.N                         → installe, redémarre
```

URL lue par l'app :
`https://github.com/kameka22/snap-studio/releases/latest/download/latest.json`
— GitHub redirige `latest` vers la release la plus récente : rien à héberger.

## Étapes

### 1. Clé de signature — à faire par toi, sur le Mac

Voir « Générer la clé » en fin de document. Tu me donnes la clé **publique** ;
la clé privée et son mot de passe vont dans les secrets GitHub.

### 2. Windows : compiler et découper

Vérifié par compilation croisée : **une seule erreur** — l'annulation d'une
découpe envoie `SIGTERM` via `libc::kill`, qui n'existe pas sous Windows.

- `slice.rs` : annulation portable (garder le `Child` et appeler `kill()`, ou
  `taskkill /PID` sous Windows) ;
- **détection du moteur** (`slicers.rs`, `presets.rs`, `slice.rs`), écrite
  aujourd'hui pour macOS (`/Applications/*.app/Contents/…`). Sans elle,
  l'app tourne sous Windows et Linux mais ne trouve pas Snapmaker Orca :

  | Système | Exécutable | Profils |
  |---|---|---|
  | macOS | `…/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca` | `Contents/Resources/profiles` |
  | Windows | `C:\Program Files\Snapmaker Orca\snapmaker-orca.exe` | `resources\profiles` |
  | Linux | AppImage ou `/usr/bin/snapmaker-orca` | `resources/profiles` (à confirmer) |

  Une fonction par système (exécutable, dossier des profils, dossier des
  données utilisateur), le reste du code inchangé. Les chemins Windows/Linux
  sont à confirmer sur une installation réelle ;
- progression de la découpe : le tube nommé est propre à Unix ; sous
  Windows, barre indéterminée (déjà le repli prévu par le code) ;
- l'interface AppKit (vibrancy, barre de titre en surimpression) reste
  réservée à macOS ; Windows et Linux gardent la fenêtre standard.

### 3. CI (`build.yml`)

- déclencheur : `workflow_dispatch` seul (lancé par `scripts/release.sh`) ;
- trois builds en parallèle :

  | Runner | Paquets publiés | Mise à jour auto |
  |---|---|---|
  | `macos-latest` (universel Intel + Apple Silicon) | `.dmg`, `.app.tar.gz` + `.sig` | oui |
  | `windows-latest` | installateur NSIS `.exe` + `.sig` | oui |
  | `ubuntu-22.04` | `.AppImage` + `.sig`, `.deb` | AppImage seulement |

- variables `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` passées au build ;
- job release : génère `latest.json` à partir des `.sig` et l'ajoute à la
  release. Le build universel sert à `darwin-aarch64` et `darwin-x86_64` ;
  `windows-x86_64` pointe vers l'installateur, `linux-x86_64` vers
  l'AppImage ;
- notes de version : liste des commits depuis la release précédente.

### 4. Configuration Tauri

- `tauri.conf.json` :
  - `bundle.createUpdaterArtifacts: true`, cible Windows `nsis` ;
  - `plugins.updater` : `pubkey`, `endpoints` (URL ci-dessus) ;
    Windows : `installMode: "passive"` (petite fenêtre de progression,
    pas de questions).
- `Cargo.toml` : `tauri-plugin-updater`.
- `update.rs` : commandes `app_version`, `update_check`, `update_install`
  (téléchargement, vérification, installation, redémarrage) — l'interface
  passe par elles, aucune permission JavaScript supplémentaire.
- `createUpdaterArtifacts` n'est activé que par la CI : un build local, sans
  clé privée, reste possible.

### 5. Interface

- **Au lancement**, si la case des Réglages est cochée (par défaut) :
  vérification en arrière-plan. Nouvelle version → **modale** (feuille
  native qui descend de la barre de titre) :
  - « Snap Studio 0.1.42 est disponible — vous avez la 0.1.37 » ;
  - notes de version ;
  - boutons **Installer et redémarrer** (par défaut) et **Plus tard** ;
  - pendant le téléchargement : barre de progression dans la modale, puis
    redémarrage automatique.
- **Réglages → section « Application »** :
  - version installée ;
  - « Rechercher les mises à jour au lancement » (case, cochée par défaut) ;
  - bouton **Rechercher les mises à jour** avec le résultat à côté :
    « Snap Studio est à jour », « Version 0.1.42 disponible » (ouvre la
    modale), ou l'erreur ;
  - date de la dernière vérification.
- **Menu** Snap Studio → « Rechercher les mises à jour… » : même action que
  le bouton (convention macOS).
- Une découpe ou un envoi en cours reporte le redémarrage à leur fin.
- Hors ligne ou GitHub injoignable : rien au lancement, message clair si la
  vérification a été demandée.

### 6. Vérification

- release `0.1.N`, installer, publier `0.1.N+1` → la modale s'ouvre au
  lancement, l'installation aboutit, l'app redémarre en `0.1.N+1` — sur
  macOS, Windows et Linux (AppImage) ;
- fichier altéré → refusé (signature invalide) ;
- sans réseau → aucune erreur au lancement ;
- case décochée → aucune vérification au lancement, le bouton fonctionne.

## Limites

- Linux : seul l'AppImage se met à jour ; le `.deb` reste manuel.
- macOS : la première installation demande le contournement Gatekeeper (app
  non signée chez Apple) ; les mises à jour, non.
- Windows : l'installateur n'est pas signé chez Microsoft ; SmartScreen
  avertit à la première installation (« Informations complémentaires »
  → « Exécuter quand même »). Les mises à jour passent sans avertissement.
- Les versions installées **avant** cette fonctionnalité ne se mettront pas à
  jour seules : une dernière installation manuelle est nécessaire.

## Générer la clé

Sur le Mac, une seule fois :

```sh
# 1. Générer la paire de clés (demande un mot de passe : en mettre un)
npx @tauri-apps/cli signer generate -w ~/.tauri/snap-studio.key

# 2. Envoyer la clé privée et son mot de passe dans les secrets GitHub
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo kameka22/snap-studio < ~/.tauri/snap-studio.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo kameka22/snap-studio
#    (la commande demande le mot de passe choisi à l'étape 1)

# 3. Afficher la clé publique, à me transmettre
cat ~/.tauri/snap-studio.key.pub
```

- Deux fichiers sont créés : `snap-studio.key` (**privée**, ne jamais la
  commiter ni la partager) et `snap-studio.key.pub` (publique, va dans le
  dépôt).
- **Sauvegarder** la clé privée et son mot de passe (gestionnaire de mots de
  passe) : perdus, les apps installées ne pourront plus jamais être mises à
  jour.
- Sans `gh` : GitHub → dépôt → Settings → Secrets and variables → Actions →
  New repository secret, mêmes noms.
