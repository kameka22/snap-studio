# Plan — voir le détail des profils

Objectif : depuis la fenêtre de découpe, afficher le contenu réel des profils
machine, impression et filament (un par tête) **tels qu'ils partent au
moteur** : héritage résolu, réglages rapides, plateau et couleurs de bobine
appliqués. On doit pouvoir répondre d'un coup d'œil à « quelle température de
plateau va-t-il utiliser ? ».

**État : implémenté** (recommandations retenues : fenêtre de découpe, lecture
seule, onglets d'Orca + « Tous les réglages »).

Point de départ : le correctif du plateau est fait (`curr_bed_type` transmis,
choix « Plateau » dans la fenêtre de découpe). Ce plan ajoute la visibilité.

## Ce qu'Orca fournit déjà

- **Disposition** : `Tab.cpp` décrit les onglets d'Orca — pages (Qualité,
  Résistance, Vitesse, Supports…), groupes (« Hauteur de couche », « Parois »…)
  et réglages de chaque groupe (527 lignes).
- **Libellés** : `PrintConfig.cpp` donne pour chaque réglage son libellé, son
  infobulle, son unité et les libellés de ses valeurs (772 définitions).
- **Français** : `localization/i18n/fr/Snapmaker_Orca_fr.po` traduit ces
  textes (« Wall loops » → « Nombre de parois »).

On reproduit donc les onglets d'Orca, en français, sans rien écrire à la main.

## Réalisation

### 1. Schéma des réglages, généré

`scripts/gen-orca-settings.py` lit les trois fichiers et produit
`ui/assets/orca-settings.json` (commité, régénéré quand Orca évolue) :

```
{ "process":  { "pages": [ { "title": "Qualité", "groups": [ { "title": "Hauteur de couche", "keys": ["layer_height", …] } ] } ] },
  "filament": { … }, "machine": { … },
  "keys": { "layer_height": { "label": "Hauteur de couche", "tooltip": "…", "unit": "mm",
            "enum": { "Textured PEI Plate": "PEI texturé", … } } } }
```

Repli en anglais pour un texte non traduit.

### 2. Rust — `preset_details`

Commande `preset_details { name, machine, overrides }` :

- valeurs **effectives** : héritage résolu, puis ce qu'ajoute Snap Studio
  (réglages rapides, plateau, couleur de la bobine) — la même fonction que
  celle qui écrit les fichiers pour le moteur, pour ne jamais diverger ;
- chaîne d'héritage (« Generic PLA @U1 0.4 → Generic PLA @U1 base →
  fdm_filament_pla »), origine (système / personnel) ;
- pour chaque réglage : modifié par Snap Studio, modifié par le profil
  personnel par rapport à son parent système, ou inchangé.

### 3. Fenêtre de détail

- Bouton ⓘ à côté de chaque liste de la fenêtre de découpe (machine,
  impression, filament de chaque tête) → grande feuille « Détails du profil ».
- En-tête : nom, origine, chaîne d'héritage.
- **Résumé** en haut, selon le profil :
  - filament : températures de buse (première couche / suivantes),
    **température du plateau pour le plateau choisi**, en évidence, et celles
    des autres plateaux en dessous ; refroidissement ; débit volumique max ;
  - impression : hauteur de couche, parois, remplissage, vitesses,
    supports ;
  - machine : plateau, hauteur max, buses, têtes.
- Onglets et groupes comme dans Orca ; une ligne par réglage : libellé, valeur
  mise en forme (unité, oui/non, libellé d'énumération, valeur par tête),
  infobulle au survol.
- Badges : « Snap Studio » (surchargé pour cette découpe), « perso » (diffère
  du profil système parent).
- Recherche dans les réglages ; « Tous les réglages » affiche aussi ceux qui
  ne sont dans aucun onglet. G-code de démarrage / fin en bloc monospace.
- Lecture seule : la modification reste dans Snapmaker Orca.

### 4. Dans la fenêtre de découpe

Sous « Plateau », une ligne qui donne le résultat : « Plateau à 65 °C »,
ou « 65 °C (T0, T1) · 60 °C (T2) » si les filaments diffèrent — on voit
le problème avant de découper.

## Étapes

1. Générateur et `orca-settings.json` (vérifier la couverture : chaque clé des
   profils U1 a un libellé).
2. `preset_details` + tests (valeurs effectives = fichiers écrits pour le
   moteur).
3. Feuille de détail : résumé, onglets, recherche, badges.
4. Ligne « Plateau à … °C » dans la fenêtre de découpe.
5. Vérification en clair / sombre sur les profils U1 (PLA, PETG, process
   0.20 mm).

## Décisions à prendre

| Question | Recommandation |
|---|---|
| Où voir les détails ? | **Fenêtre de découpe d'abord** ; une page « Profils » autonome plus tard si utile. |
| Lecture seule ou modification ? | **Lecture seule** : la modification est un gros chantier, Orca la fait déjà. |
| Tous les réglages ou seulement ceux des onglets d'Orca ? | **Onglets d'Orca**, plus un interrupteur « Tous les réglages ». |
