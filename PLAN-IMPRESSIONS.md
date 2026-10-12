# Plan — impressions : en cours, file d'attente, historique

**État : implémenté.** Reste à valider sur une vraie U1 : fin d'impression,
proposition de la suivante, pause / reprise / annulation.

Décisions : file **par imprimante** (modifiable), historique des **20 dernières**
impressions, **Pause / Reprendre / Annuler** depuis la fiche (avec
confirmation), case **« Le plateau est libre »** obligatoire avant de lancer
la suivante, **notification macOS** en fin d'impression. **Rien ne se lance
tout seul.**

## Données — `jobs.rs`

Un magasin `jobs.json` dans les données de l'application, et le G-code de
chaque travail à côté (`jobs/<id>.gcode`) : les aperçus de découpe sont
temporaires, une impression en attente doit survivre à un redémarrage.

```
Job { id, name, printer_id, file, remote, state, created, started, finished,
      options, tools, profile { machine, process, filaments, bed, colors },
      source, stats }
state : queued | printing | complete | cancelled | error | finished
```

- l'ordre des `queued` dans le magasin est l'ordre de la file ;
- le bilan (`stats`) est recalculé depuis le G-code à l'ajout ;
- au-delà de 20 impressions terminées, les plus anciennes et leur G-code
  disparaissent.

## Lancement

`launch` (extrait de `print_send`) : préparation (macros d'options), envoi du
fichier, démarrage. Utilisé par l'envoi depuis l'aperçu et par « Lancer » d'un
élément de la file. Toute impression lancée par Snap Studio est enregistrée
(`printing`, nom du fichier sur l'imprimante) : sa fiche garde le bilan.

## Suivi en arrière-plan

Une tâche interroge toutes les 8 s les imprimantes enregistrées
(`printers::status`) :

- instantané `prints-status` pour la barre latérale et les fiches ;
- passage de « en impression / pause » à autre chose : le travail est clos
  (terminé, annulé, erreur), notification macOS ;
- imprimante libre et file non vide (fin d'impression ou lancement de l'app) :
  évènement `queue-next` — **une seule fois** jusqu'à la prochaine impression ;
  « Plus tard » ne repose pas la question.

## Interface

- Barre latérale : entrée **Impressions** (badge = en cours + en attente),
  sous-éléments : impressions en cours (anneau de progression), puis la file
  numérotée.
- Vue **Impressions** : vue d'ensemble (En cours / En attente / Terminées) et
  **fiche** — vignette, état, progression, temps, couche ; bilan (durée,
  filament par tête, coût, plateau, profils, options, dates) ; températures ;
  actions selon l'état.
- Envoi : imprimante occupée → « Ajouter à la file d'attente » ; libre →
  « Lancer l'impression » et « Mettre en file ».
- Fenêtre **« Lancer la suivante ? »** avec la case « Le plateau est libre ».
