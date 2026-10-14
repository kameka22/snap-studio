//! Les conversations de l'onglet IA.
//!
//! Chaque conversation possède son dossier, et ce dossier est son identité :
//! le nom du dossier sert aussi de `--session-id` à Claude Code. La reprise
//! devient alors déterministe — on n'a jamais à fouiller l'historique de Claude
//! ni à deviner quelle session appartient à quel objet.
//!
//! ```text
//! ~/.config/snap-studio/ia/<uuid>/
//!   meta.json
//!   workspace/          ← monté dans le conteneur
//!     CLAUDE.md  source.stl  outils/  out/current.stl  versions/v1.stl
//! ```
//!
//! Une conversation peut aussi partir de rien, pour concevoir un objet : pas de
//! `source.stl` alors, et `out/current.stl` n'existe qu'au premier export.
//!
//! Le dossier de travail appartient à Claude ; l'application n'y écrit qu'à la
//! création, puis se contente de regarder ce qui en sort.

use crate::mesh::{Mat, MeshData};
use crate::write3mf::SceneObject;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Conversation {
    /// UUID v4 : nom du dossier et identifiant de session Claude.
    pub id: String,
    pub title: String,
    /// Chemin du 3MF d'origine, tel qu'il était au moment de la création.
    pub source: String,
    pub source_name: String,
    /// Demande initiale, envoyée au premier passage dans le terminal.
    #[serde(default)]
    pub prompt: String,
    /// « container » ou « local ».
    pub engine: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// Numéro de la version affichée.
    #[serde(default = "one")]
    pub version: u32,
    /// Chemin du 3MF exporté vers vos fichiers, une fois le travail terminé.
    #[serde(default)]
    pub saved: Option<String>,
    /// Vrai dès que la session Claude a été créée : on la reprend ensuite.
    #[serde(default)]
    pub started: bool,
    /// « create » pour un objet conçu de zéro, vide pour une modification.
    #[serde(default)]
    pub kind: String,
    /// Dossier où verser l'objet créé ; une modification retourne, elle,
    /// auprès de son original.
    #[serde(default)]
    pub dest_dir: Option<String>,
    /// Encombrement maximal demandé pour un objet créé, en millimètres.
    #[serde(default)]
    pub bounds: Option<[f32; 3]>,
}

impl Conversation {
    pub fn is_creation(&self) -> bool {
        self.kind == "create"
    }
}

fn one() -> u32 {
    1
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ------------------------------------------------------------ emplacements

/// `~/.config/snap-studio/ia`, et non le dossier de préférences du système.
///
/// Ce chemin est monté tel quel dans le conteneur : il doit rester court et
/// sans espace, ce que « Application Support » ne permet pas.
pub fn root() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    let d = base.join("snap-studio").join("ia");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn dir(id: &str) -> PathBuf {
    root().join(id)
}

pub fn workspace(id: &str) -> PathBuf {
    dir(id).join("workspace")
}

/// Le maillage que l'application affiche : ce que Claude a produit en dernier.
pub fn current(id: &str) -> PathBuf {
    workspace(id).join("out").join("current.stl")
}

fn meta_path(id: &str) -> PathBuf {
    dir(id).join("meta.json")
}

// ------------------------------------------------------------ magasin

pub fn get(id: &str) -> Result<Conversation> {
    let raw = std::fs::read(meta_path(id))?;
    Ok(serde_json::from_slice(&raw)?)
}

pub fn save(c: &Conversation) -> Result<()> {
    let dst = meta_path(&c.id);
    if let Some(p) = dst.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = dst.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(c)?)?;
    std::fs::rename(&tmp, &dst)?;
    Ok(())
}

/// Les conversations, de la plus récemment active à la plus ancienne.
pub fn list() -> Vec<Conversation> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root()) else {
        return out;
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if let Ok(c) = get(&name) {
            out.push(c);
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

/// Un identifiant valable est l'UUID que nous avons engendré, rien d'autre.
///
/// Comparer des chemins ne suffit pas : `..` reste sous la racine au sens
/// lexical, et c'est le noyau qui le résout ensuite — un effacement partirait
/// alors bien plus loin que prévu.
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

pub fn remove(id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(anyhow!("conversation inconnue"));
    }
    std::fs::remove_dir_all(dir(id))?;
    Ok(())
}

/// Note qu'une session Claude existe désormais pour cette conversation.
pub fn mark_started(id: &str) {
    if let Ok(mut c) = get(id) {
        c.started = true;
        c.updated_at = now();
        let _ = save(&c);
    }
}


/// Emplacement où Claude Code range la session d'un dossier de travail.
///
/// Il nomme le dossier d'après le chemin, chaque caractère qui n'est ni lettre
/// ni chiffre devenant un tiret : `/Users/moi/.config/snap-studio/ia/<id>/workspace`
/// donne `-Users-moi--config-snap-studio-ia-<id>-workspace`.
pub fn session_file(id: &str) -> PathBuf {
    let slug: String = workspace(id)
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".claude")
        .join("projects")
        .join(slug)
        .join(format!("{id}.jsonl"))
}

/// Vrai si Claude a vraiment une session à reprendre.
///
/// Vaut aussi en conteneur, ce qui a été vérifié sur machine : yolobox monte le
/// dossier de travail à son chemin réel, et `--claude-config` partage
/// `~/.claude/projects`. Une conversation menée dans le bac à sable dépose donc
/// sa session à cet emplacement exact, côté hôte.
///
/// On ne se fie pas à notre propre drapeau : ouvrir le terminal ne crée pas de
/// session, seul un premier échange le fait. Quelqu'un qui ouvre une
/// conversation puis la referme sans rien dire n'en laisse aucune trace, et une
/// reprise échouerait alors sur « No conversation found with session ID ».
pub fn has_session(id: &str) -> bool {
    session_file(id).is_file()
}

// ------------------------------------------------------------ conversions

/// Géométrie complète d'un 3MF, sans échantillonnage.
///
/// Le visualiseur, lui, se contente d'un budget de triangles : l'aperçu reste
/// fidèle. Pour une conversion, en revanche, il faut tout garder.
pub fn mesh_of_3mf(path: &Path) -> Result<MeshData> {
    let mut zip = crate::model3mf::open(path)?;
    crate::mesh::load_mesh(&mut zip, usize::MAX)
}

/// Convertit le 3MF d'origine en STL dans le dossier de travail.
pub fn source_to_stl(src: &Path, dst: &Path) -> Result<usize> {
    let m = mesh_of_3mf(src)?;
    crate::stl::write(dst, &m.tris)?;
    Ok(m.tris.len())
}

/// Reconvertit un STL en 3MF, prêt à découper.
pub fn stl_to_3mf(src: &Path, dst: &Path, name: &str) -> Result<usize> {
    let m = crate::stl::read(src)?;
    let n = m.tris.len();
    crate::write3mf::write_scene(
        dst,
        &[SceneObject {
            name: name.to_string(),
            tris: m.tris,
            transform: Mat::IDENTITY,
            extruder: None,
        }],
    )?;
    Ok(n)
}

// ------------------------------------------------------------ création

/// Titre lisible déduit de la demande, sinon du nom de fichier.
fn title_for(prompt: &str, source: &Path) -> String {
    let p = prompt.trim();
    if !p.is_empty() {
        let mut t: String = p.chars().take(60).collect();
        if p.chars().count() > 60 {
            t.push('…');
        }
        return t;
    }
    source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Sans titre".into())
}

/// Prépare une conversation : dossier, consignes, outils, objet converti.
pub fn create(source: &Path, prompt: &str, engine: &str) -> Result<Conversation> {
    if !source.is_file() {
        return Err(anyhow!("fichier introuvable"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ws = workspace(&id);
    std::fs::create_dir_all(ws.join("outils"))?;
    std::fs::create_dir_all(ws.join("out"))?;
    std::fs::create_dir_all(ws.join("versions"))?;

    // La conversion d'abord : si l'objet est illisible, rien ne doit rester.
    let src_stl = ws.join("source.stl");
    let tris = match source_to_stl(source, &src_stl) {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_dir_all(dir(&id));
            return Err(e);
        }
    };
    std::fs::copy(&src_stl, ws.join("out").join("current.stl"))?;
    std::fs::copy(&src_stl, ws.join("versions").join("v1.stl"))?;

    let name = source.file_name().unwrap_or_default().to_string_lossy().to_string();
    std::fs::write(ws.join("CLAUDE.md"), consignes(&name, tris))?;
    std::fs::write(ws.join("outils").join("mesure.py"), MESURE_PY)?;
    std::fs::write(ws.join("outils").join("exporter.py"), EXPORTER_PY)?;

    let _ = write_previews(&id);

    let c = Conversation {
        id,
        title: title_for(prompt, source),
        source: source.to_string_lossy().to_string(),
        source_name: name,
        prompt: prompt.trim().to_string(),
        engine: engine.to_string(),
        created_at: now(),
        updated_at: now(),
        version: 1,
        saved: None,
        started: false,
        kind: String::new(),
        dest_dir: None,
        bounds: None,
    };
    save(&c)?;
    Ok(c)
}

/// Prépare une conversation sans objet de départ : Claude conçoit la pièce.
///
/// Le dossier de sortie existe d'emblée — la surveillance s'y accroche — mais
/// il reste vide : le premier maillage exporté deviendra la v1.
pub fn create_blank(
    prompt: &str,
    engine: &str,
    dest_dir: &Path,
    bounds: Option<[f32; 3]>,
) -> Result<Conversation> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(anyhow!("décrivez l'objet à créer"));
    }
    if !dest_dir.is_dir() {
        return Err(anyhow!("dossier de destination introuvable"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ws = workspace(&id);
    std::fs::create_dir_all(ws.join("outils"))?;
    std::fs::create_dir_all(ws.join("out"))?;
    std::fs::create_dir_all(ws.join("versions"))?;
    std::fs::write(ws.join("CLAUDE.md"), consignes_creation(bounds))?;
    std::fs::write(ws.join("outils").join("mesure.py"), MESURE_PY)?;
    std::fs::write(ws.join("outils").join("exporter.py"), EXPORTER_PY)?;

    let c = Conversation {
        id,
        title: title_for(prompt, Path::new("Nouvel objet")),
        source: String::new(),
        source_name: String::new(),
        prompt: prompt.to_string(),
        engine: engine.to_string(),
        created_at: now(),
        updated_at: now(),
        version: 0,
        saved: None,
        started: false,
        kind: "create".into(),
        dest_dir: Some(dest_dir.to_string_lossy().to_string()),
        bounds,
    };
    save(&c)?;
    Ok(c)
}

/// Le mode d'emploi laissé à Claude dans le dossier de travail.
fn consignes(source_name: &str, tris: usize) -> String {
    format!(
        "# Modification d'une pièce à imprimer

Tu travailles sur **{source_name}**, converti en STL pour cette session. Ce que
tu écris s'affiche en direct dans l'application, à côté de cette conversation.

## Regarde avant d'agir

Le dossier `apercu/` contient trois rendus de l'état courant — `face.png`,
`trois-quarts.png`, `dessus.png` — que l'application régénère après **chaque**
modification que tu enregistres.

Ouvre-les. C'est ta seule façon de voir la pièce : un trou décentré, une paroi
qui traverse, une pièce posée de travers ne se lisent pas dans les coordonnées.
Regarde avant de modifier, et regarde encore après.

## Les fichiers

- `source.stl` — l'objet d'origine. **Ne le modifie jamais.**
- `out/current.stl` — l'état courant, celui qui s'affiche à l'écran.
- `apercu/` — les trois rendus. En lecture seule, l'application les écrit.
- `versions/` — l'historique, géré par l'application. N'y touche pas.
- `outils/mesure.py` — dimensions, volume, étanchéité.
- `outils/exporter.py` — vérifie un maillage et l'installe comme état courant.

## La marche à suivre

1. `python3 outils/mesure.py` puis regarde `apercu/trois-quarts.png`.
2. Écris un script Python de transformation, avec `trimesh`.
3. Installe le résultat : `python3 outils/exporter.py resultat.stl`
4. Regarde de nouveau les aperçus, et recommence si ce n'est pas ça.

## Ce qui compte

- Les unités sont des **millimètres**, l'axe Z est la hauteur, et la pièce est
  posée sur `z = 0`. Après une rotation, repose-la au sol.
- Le maillage doit rester **étanche** : sans quoi la découpe échouera.
- Pars toujours de `out/current.stl`, jamais de `source.stl`, pour enchaîner
  plusieurs modifications.
- Avance par petites étapes vérifiables plutôt qu'en un seul grand script.
- Si une demande est ambiguë — quel côté, quelle face, quelle dimension —
  demande plutôt que de deviner.

L'objet d'origine compte {tris} triangles.

## Outils disponibles

`trimesh`, `manifold3d` (booléens), `numpy`. Pas de Blender.
"
    )
}

/// Le mode d'emploi d'une conversation qui part de rien.
fn consignes_creation(bounds: Option<[f32; 3]>) -> String {
    let fmt = |v: f32| format!("{v:.0}");
    let gabarit = match bounds {
        Some([x, y, z]) => format!(
            "La pièce doit tenir dans **{} × {} × {} mm** (X × Y × Z) : c'est le
volume imprimable demandé. Vérifie-le avec `outils/mesure.py` à chaque export.",
            fmt(x),
            fmt(y),
            fmt(z)
        ),
        None => "Aucun encombrement n'est imposé ; reste raisonnable et demande si la
taille n'est pas claire."
            .into(),
    };
    format!(
        "# Création d'une pièce à imprimer

Tu conçois une pièce **à partir de rien**, d'après la description de
l'utilisateur. Ce que tu exportes s'affiche en direct dans l'application, à côté
de cette conversation.

## Avant de modéliser

Si une cote, un usage ou une contrainte manque — diamètre de vis, épaisseur,
côté d'appui — **pose la question** plutôt que de deviner. Annonce ensuite en
quelques lignes ce que tu vas construire : formes de base, cotes principales,
orientation d'impression.

## Les fichiers

- `out/current.stl` — l'état courant, celui qui s'affiche à l'écran. Il
  n'existe pas encore : c'est ton premier export qui le crée.
- `apercu/` — trois rendus de l'état courant (`face.png`, `trois-quarts.png`,
  `dessus.png`), régénérés par l'application après **chaque** export. En
  lecture seule.
- `versions/` — l'historique, géré par l'application. N'y touche pas.
- `outils/mesure.py` — dimensions, volume, étanchéité.
- `outils/exporter.py` — vérifie un maillage et l'installe comme état courant.

## La marche à suivre

1. Écris un script Python, `modele.py`, qui construit la pièce avec `trimesh`
   (primitives : boîtes, cylindres, extrusions de profils) et `manifold3d` pour
   les booléens. Garde les cotes en variables nommées en tête du script : on
   y reviendra.
2. Installe le résultat : `python3 outils/exporter.py resultat.stl`
3. Ouvre `apercu/trois-quarts.png` et lance `python3 outils/mesure.py`.
4. Corrige et recommence ; chaque export devient une nouvelle version.

Les aperçus sont ta seule façon de voir la pièce : un trou décentré, une paroi
qui traverse ne se lisent pas dans les coordonnées. Regarde après chaque export.

## Ce qui compte

- Les unités sont des **millimètres**, l'axe Z est la hauteur, et la pièce est
  posée sur `z = 0`, centrée en X et Y.
- {gabarit}
- Le maillage doit être **étanche** : sans quoi la découpe échouera.
- Pense à l'impression FDM : une grande face plane au sol, des surplombs de
  moins de 45°, des parois d'au moins 1,2 mm, 0,2 à 0,3 mm de jeu entre deux
  pièces qui s'emboîtent.
- Avance par petites étapes vérifiables plutôt qu'en un seul grand script.

## Outils disponibles

`trimesh`, `manifold3d` (booléens), `numpy`. Pas de Blender, pas d'OpenSCAD.
"
    )
}

const MESURE_PY: &str = r#"#!/usr/bin/env python3
"""Dimensions, volume et santé d'un maillage."""
import sys
import trimesh

path = sys.argv[1] if len(sys.argv) > 1 else "out/current.stl"
m = trimesh.load(path, force="mesh")
x, y, z = m.extents
print(f"fichier    : {path}")
print(f"dimensions : {x:.2f} x {y:.2f} x {z:.2f} mm")
print(f"minimum    : {m.bounds[0].round(2).tolist()}")
print(f"maximum    : {m.bounds[1].round(2).tolist()}")
print(f"volume     : {m.volume / 1000:.2f} cm3")
print(f"faces      : {len(m.faces)}")
print(f"etanche    : {'oui' if m.is_watertight else 'NON'}")
if not m.is_watertight:
    print("attention  : un maillage non etanche ne se decoupe pas")
"#;

const EXPORTER_PY: &str = r#"#!/usr/bin/env python3
"""Verifie un maillage puis l'installe comme etat courant.

    python3 outils/exporter.py resultat.stl
"""
import shutil
import sys
import trimesh

if len(sys.argv) < 2:
    sys.exit("usage : exporter.py <fichier.stl>")

src = sys.argv[1]
m = trimesh.load(src, force="mesh")
if len(m.faces) == 0:
    sys.exit("refus : maillage vide")
if not m.is_watertight:
    print("attention : maillage non etanche, la decoupe echouera peut-etre")

shutil.copyfile(src, "out/current.stl")
x, y, z = m.extents
print(f"installe : {x:.2f} x {y:.2f} x {z:.2f} mm, {len(m.faces)} faces")
print("les apercus sont regeneres : regarde apercu/trois-quarts.png")
"#;

// ------------------------------------------------------------ outillage

#[derive(Serialize)]
pub struct Engine {
    /// Le binaire `docker` est installé.
    pub docker: bool,
    /// Le démon répond — installé ne veut pas dire démarré.
    pub daemon: bool,
    pub yolobox: bool,
    pub claude: bool,
}

/// Le démon Docker répond-il ?
///
/// Un client installé sans démon actif est le cas le plus courant sur macOS,
/// où l'un s'installe avec `brew` et l'autre se lance à la main. Sans cette
/// vérification, l'application proposerait un bac à sable qui échouerait.
///
/// L'attente est bornée : une socket absente répond tout de suite, mais un
/// démon en train de démarrer peut faire patienter indéfiniment.
fn docker_ready(bin: &Path) -> bool {
    let bin = bin.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ok = std::process::Command::new(bin)
            .args(["info", "--format", "{{.ServerVersion}}"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let _ = tx.send(ok);
    });
    rx.recv_timeout(std::time::Duration::from_millis(2500))
        .unwrap_or(false)
}

/// Ce qui est installé — et utilisable — sur la machine.
pub fn engine() -> Engine {
    let docker = crate::util::which("docker");
    Engine {
        daemon: docker.as_deref().map(docker_ready).unwrap_or(false),
        docker: docker.is_some(),
        yolobox: crate::util::which("yolobox").is_some(),
        claude: crate::util::which("claude").is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube_3mf(dst: &Path) {
        let tris = crate::stl::tests_cube();
        crate::write3mf::write_scene(
            dst,
            &[SceneObject {
                name: "cube".into(),
                tris,
                transform: Mat::IDENTITY,
                extruder: None,
            }],
        )
        .unwrap();
    }

    #[test]
    fn creates_and_removes_a_workspace() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("cube.3mf");
        cube_3mf(&src);

        let c = create(&src, "Incline le plateau de 15°", "local").unwrap();
        let ws = workspace(&c.id);
        for f in [
            "CLAUDE.md",
            "source.stl",
            "outils/mesure.py",
            "outils/exporter.py",
            "out/current.stl",
            "versions/v1.stl",
        ] {
            assert!(ws.join(f).exists(), "{f} devrait exister");
        }
        assert_eq!(c.title, "Incline le plateau de 15°");
        assert_eq!(c.version, 1);
        assert!(list().iter().any(|x| x.id == c.id));
        assert!(get(&c.id).is_ok());

        remove(&c.id).unwrap();
        assert!(!dir(&c.id).exists());
        assert!(!list().iter().any(|x| x.id == c.id));
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn converts_both_ways() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("aller.3mf");
        cube_3mf(&src);

        let stl = tmp.join("milieu.stl");
        let n = source_to_stl(&src, &stl).unwrap();
        assert_eq!(n, 12);

        let back = tmp.join("retour.3mf");
        assert_eq!(stl_to_3mf(&stl, &back, "cube").unwrap(), 12);

        let a = mesh_of_3mf(&src).unwrap();
        let b = mesh_of_3mf(&back).unwrap();
        assert_eq!(a.tris.len(), b.tris.len());
        for k in 0..3 {
            assert!((a.min[k] - b.min[k]).abs() < 1e-4, "boite conservee");
            assert!((a.max[k] - b.max[k]).abs() < 1e-4, "boite conservee");
        }
        for f in [src, stl, back] {
            let _ = std::fs::remove_file(f);
        }
    }


    #[test]
    fn versions_are_captured_and_restored() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("versions.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();

        assert_eq!(versions(&c.id).len(), 1, "l'original est la version 1");

        // Claude écrit un objet différent : une seule face en moins.
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10);
        crate::stl::write(&current(&c.id), &tris).unwrap();
        assert_eq!(capture(&c.id).unwrap(), 2);
        assert_eq!(versions(&c.id).len(), 2);
        assert_eq!(get(&c.id).unwrap().version, 2);
        assert_eq!(crate::stl::read(&current(&c.id)).unwrap().tris.len(), 10);

        // Retour en arrière : l'état courant redevient celui d'origine.
        revert(&c.id, 1).unwrap();
        assert_eq!(crate::stl::read(&current(&c.id)).unwrap().tris.len(), 12);
        assert_eq!(get(&c.id).unwrap().version, 1);
        assert_eq!(versions(&c.id).len(), 2, "un retour n'archive rien");
        assert!(revert(&c.id, 9).is_err(), "version inexistante");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// Le cœur de la surveillance, sans fenêtre ni fil d'exécution : ce qui
    /// mérite d'être archivé, et ce qui ne le mérite pas.
    #[test]
    fn only_real_changes_are_archived() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("veille.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();
        let last = Mutex::new(hash_file(&current(&c.id)).unwrap());

        // Rien n'a bougé.
        assert!(matches!(consider(&c.id, &last), Change::Nothing));

        // Claude écrit un objet différent.
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10);
        crate::stl::write(&current(&c.id), &tris).unwrap();
        let Change::Archived(v, stats) = consider(&c.id, &last) else {
            panic!("le changement aurait dû être archivé");
        };
        assert_eq!(v, 2);
        assert_eq!(stats.triangles, 10);
        assert_eq!(stats.watertight, Some(false));

        // Réécrire le même contenu ne doit pas créer une version de plus.
        crate::stl::write(&current(&c.id), &tris).unwrap();
        assert!(matches!(consider(&c.id, &last), Change::Nothing));
        assert_eq!(versions(&c.id).len(), 2);

        // Un fichier tronqué en pleine écriture : on repassera.
        std::fs::write(current(&c.id), b"un fichier a moitie ecrit").unwrap();
        assert!(matches!(consider(&c.id, &last), Change::TryAgain));
        assert_eq!(versions(&c.id).len(), 2, "rien n'a été archivé entre-temps");

        // Et un retour en arrière ne relance pas l'archivage.
        revert(&c.id, 1).unwrap();
        *last.lock().unwrap() = hash_file(&current(&c.id)).unwrap();
        assert!(matches!(consider(&c.id, &last), Change::Nothing));

        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn stats_describe_the_current_object() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("stats.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();
        let s = current_stats(&c.id).unwrap();
        assert_eq!(s.triangles, 12);
        assert_eq!(s.watertight, Some(true));
        assert!((s.volume_cm3 - 1.0).abs() < 1e-3);
        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// Un identifiant fabriqué ne doit pas pouvoir remonter hors du magasin :
    /// « .. » reste sous la racine au sens lexical, mais pas pour le noyau.
    #[test]
    fn refuses_a_path_outside_the_store() {
        for bad in ["..", ".", "", "../evasion", "a/b", "../../Documents", "\u{e9}"] {
            assert!(remove(bad).is_err(), "« {bad} » aurait dû être refusé");
        }
        assert!(root().is_dir(), "le magasin est toujours là");
        assert!(valid_id("b703e739-e760-4642-89a6-881a754d420c"));
        assert!(!valid_id("b703e739-e760-4642-89a6-881a754d420"), "trop court");
    }

    #[test]
    fn a_blank_conversation_starts_without_an_object() {
        let dest = std::env::temp_dir().join("snapstudio-ia-blank");
        std::fs::create_dir_all(&dest).unwrap();
        assert!(create_blank("  ", "local", &dest, None).is_err(), "description obligatoire");

        let c = create_blank("Crochet mural pour casque", "local", &dest, Some([270.0, 270.0, 270.0]))
            .unwrap();
        let ws = workspace(&c.id);
        assert!(c.is_creation());
        assert_eq!(c.version, 0);
        assert!(ws.join("out").is_dir(), "la surveillance a besoin du dossier");
        assert!(!current(&c.id).exists());
        assert!(!ws.join("source.stl").exists());
        let md = std::fs::read_to_string(ws.join("CLAUDE.md")).unwrap();
        assert!(md.contains("270 × 270 × 270 mm"));
        assert!(save_to_files(&c.id).is_err(), "rien à enregistrer avant le premier export");

        // Premier export : la v1 apparaît, et l'objet part vers le dossier choisi.
        let tris = crate::stl::tests_cube();
        crate::stl::write(&current(&c.id), &tris).unwrap();
        let last = Mutex::new(0);
        assert!(matches!(consider(&c.id, &last), Change::Archived(1, _)));
        assert!(previews_dir(&c.id).join("trois-quarts.png").is_file());
        let out = save_to_files(&c.id).unwrap();
        assert_eq!(Path::new(&out).parent(), Some(dest.as_path()));
        assert!(out.ends_with("crochet-mural-pour-casque-ia.3mf"), "{out}");
        std::fs::remove_file(&out).unwrap();
        remove(&c.id).unwrap();
    }

    #[test]
    fn slugs_make_tidy_file_names() {
        assert_eq!(slug("Crochet mural, 60 mm"), "crochet-mural-60-mm");
        assert_eq!(slug("Boîte à vis…"), "boîte-à-vis");
        assert_eq!(slug("  !!  "), "objet");
    }

    #[test]
    fn title_falls_back_on_the_file_name() {
        let p = PathBuf::from("/tmp/support-v2.3mf");
        assert_eq!(title_for("", &p), "support-v2");
        assert_eq!(title_for("  Perce un trou  ", &p), "Perce un trou");
        let long = "a".repeat(80);
        assert_eq!(title_for(&long, &p).chars().count(), 61, "tronqué avec points de suspension");
    }
}

#[cfg(test)]
mod essai_reel {
    use super::*;

    /// Prépare une vraie conversation à partir d'un 3MF du disque.
    ///
    /// `IA_3MF=/chemin/objet.3mf cargo test essai_reel -- --nocapture`
    #[test]
    fn prepares_a_real_file() {
        let Ok(src) = std::env::var("IA_3MF") else {
            return;
        };
        let src = PathBuf::from(src);
        let c = create(&src, "Essai", "local").unwrap();
        let ws = workspace(&c.id);
        let stl = crate::stl::read(&ws.join("source.stl")).unwrap();
        let orig = mesh_of_3mf(&src).unwrap();
        println!(
            "{} : {} triangles, encombrement {:?} mm",
            c.source_name,
            stl.tris.len(),
            stl.size()
        );
        assert_eq!(stl.tris.len(), orig.tris.len(), "aucun triangle perdu");
        for k in 0..3 {
            assert!((stl.min[k] - orig.min[k]).abs() < 1e-3);
            assert!((stl.max[k] - orig.max[k]).abs() < 1e-3);
        }

        // Et le retour en 3MF doit rester fidèle.
        let back = ws.join("retour.3mf");
        stl_to_3mf(&ws.join("out/current.stl"), &back, "objet").unwrap();
        let round = mesh_of_3mf(&back).unwrap();
        assert_eq!(round.tris.len(), orig.tris.len());
        println!("aller-retour vérifié, dossier : {}", ws.display());

        // Les aperçus : ce que Claude ouvrira pour regarder son travail.
        write_previews(&c.id).unwrap();
        if let Ok(dest) = std::env::var("IA_PNG") {
            std::fs::create_dir_all(&dest).unwrap();
            for (name, _) in VIEWS {
                let from = previews_dir(&c.id).join(format!("{name}.png"));
                let bytes = std::fs::metadata(&from).unwrap().len();
                assert!(bytes > 2000, "{name}.png fait {bytes} octets");
                std::fs::copy(&from, std::path::Path::new(&dest).join(format!("{name}.png")))
                    .unwrap();
                println!("aperçu {name} : {bytes} octets");
            }
        }

        // Et le retour dans les fichiers de l'utilisateur.
        let saved = save_to_files(&c.id).unwrap();
        println!("enregistré : {saved}");
        assert!(std::path::Path::new(&saved).is_file());
        assert_eq!(get(&c.id).unwrap().saved.as_deref(), Some(saved.as_str()));
        let back = mesh_of_3mf(std::path::Path::new(&saved)).unwrap();
        assert_eq!(back.tris.len(), orig.tris.len(), "le 3MF rendu est complet");
        std::fs::remove_file(&saved).unwrap();

        remove(&c.id).unwrap();
    }
}


// ------------------------------------------------------------ bac à sable

/// Fragment de Dockerfile ajouté à l'image du bac à sable.
///
/// Volontairement léger : trimesh couvre les booléens, les mesures et les
/// réparations, ce qui suffit à retoucher une pièce. Blender viendrait ici le
/// jour où une demande l'exigera vraiment.
const DOCKERFILE: &str = "\
# Outillage de modelage des conversations IA de Snap Studio.
#
# Installé en tant qu'administrateur, donc à l'échelle du système : le dossier
# personnel du conteneur est recouvert par un volume à l'exécution, et tout ce
# qui y serait posé à la construction disparaîtrait.
USER root
RUN pip3 install --no-cache-dir --break-system-packages \\
      trimesh manifold3d numpy
USER yolo
";

/// Le fragment sur le disque, écrit s'il manque.
///
/// Il est partagé par toutes les conversations : le bac à sable ne se construit
/// qu'une fois, et les suivantes démarrent aussitôt.
pub fn dockerfile() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .unwrap_or_else(std::env::temp_dir)
        .join("snap-studio");
    let _ = std::fs::create_dir_all(&base);
    let p = base.join("yolobox.dockerfile");
    if std::fs::read_to_string(&p).ok().as_deref() != Some(DOCKERFILE) {
        let _ = std::fs::write(&p, DOCKERFILE);
    }
    p
}

// ------------------------------------------------------------ aperçus

/// Les trois vues que Claude peut ouvrir pour regarder son travail.
/// La vue de dessus est volontairement inclinée d'une vingtaine de degrés :
/// à l'aplomb exact, toutes les faces du dessus se valent et le relief
/// disparaît — une gravure de 0,5 mm rendait un disque uniforme.
const VIEWS: [(&str, [f32; 3]); 3] = [
    ("face", [0.0, -1.0, 0.12]),
    ("trois-quarts", [0.62, -1.0, 0.68]),
    ("dessus", [0.0, -0.36, 1.0]),
];

/// Budget de triangles pour un aperçu : la silhouette n'y gagne rien au-delà,
/// et un maillage dense coûterait plusieurs secondes par vue.
const PREVIEW_BUDGET: usize = 250_000;

/// Pose le rendu sur un fond sombre.
///
/// Les pièces sont claires et le rendu les éclaire jusqu'au blanc : sur un fond
/// blanc, la silhouette s'évanouit et il devient impossible de juger d'un
/// contour. Un fond ardoise rend la forme lisible quoi qu'il arrive.
fn flatten(img: image::RgbaImage) -> image::RgbaImage {
    const BG: [u8; 3] = [38, 42, 52];
    let mut out = img;
    for p in out.pixels_mut() {
        let a = p.0[3] as f32 / 255.0;
        for k in 0..3 {
            p.0[k] = (p.0[k] as f32 * a + BG[k] as f32 * (1.0 - a)).round() as u8;
        }
        p.0[3] = 255;
    }
    out
}

pub fn previews_dir(id: &str) -> PathBuf {
    workspace(id).join("apercu")
}

/// Rend trois vues de l'état courant dans `apercu/`.
///
/// C'est la pièce qui change tout : sans image, Claude modifie un maillage à
/// l'aveugle et ne peut pas constater qu'un trou est décentré. Il lui suffit
/// d'ouvrir ces fichiers avec son outil de lecture.
///
/// Elles sont écrites hors du dossier surveillé, pour ne pas réveiller la
/// surveillance à chaque rendu.
pub fn write_previews(id: &str) -> Result<()> {
    let mut mesh = crate::stl::read(&current(id))?;
    crate::mesh::downsample(&mut mesh, PREVIEW_BUDGET);
    let dir = previews_dir(id);
    std::fs::create_dir_all(&dir)?;
    for (name, eye) in VIEWS {
        let img = flatten(crate::render::render_from(&mesh, 720, eye));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
        std::fs::write(dir.join(format!("{name}.png")), png)?;
    }
    Ok(())
}

/// La vue de trois quarts, pour la vignette d'un objet créé : il n'a pas
/// d'original dont tirer une miniature.
pub fn preview_png(id: &str) -> Result<Vec<u8>> {
    if !valid_id(id) {
        return Err(anyhow!("conversation inconnue"));
    }
    Ok(std::fs::read(previews_dir(id).join("trois-quarts.png"))?)
}

/// Remet à jour ce qui appartient à l'application dans un dossier de travail.
///
/// Les consignes et les outils s'améliorent au fil des versions : une
/// conversation ouverte il y a deux semaines doit en profiter, sans quoi Claude
/// y travaillerait avec un mode d'emploi périmé — et sans aperçus, ceux-ci
/// n'ayant pas toujours existé.
pub fn refresh_workspace(id: &str) {
    let ws = workspace(id);
    if !ws.is_dir() {
        return;
    }
    let Ok(c) = get(id) else { return };
    let text = if c.is_creation() {
        consignes_creation(c.bounds)
    } else {
        let tris = crate::stl::count(&ws.join("source.stl")).unwrap_or(0);
        consignes(&c.source_name, tris)
    };
    let _ = std::fs::create_dir_all(ws.join("outils"));
    let _ = std::fs::write(ws.join("CLAUDE.md"), text);
    let _ = std::fs::write(ws.join("outils").join("mesure.py"), MESURE_PY);
    let _ = std::fs::write(ws.join("outils").join("exporter.py"), EXPORTER_PY);
    if current(id).is_file() && !previews_dir(id).join("trois-quarts.png").is_file() {
        let _ = write_previews(id);
    }
}

// ------------------------------------------------------------ enregistrement

/// Nom libre dans un dossier : `support-ia.3mf`, puis `support-ia-2.3mf`.
fn free_name(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}-ia.3mf"));
    if !first.exists() {
        return first;
    }
    for n in 2..999 {
        let p = dir.join(format!("{stem}-ia-{n}.3mf"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-ia-{}.3mf", now()))
}

/// Nom de fichier tiré d'un titre : « Crochet mural, 60 mm » → `crochet-mural-60-mm`.
fn slug(title: &str) -> String {
    let mut out = String::new();
    for ch in title.trim_end_matches('…').chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_end_matches('-').chars().take(40).collect();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "objet".into()
    } else {
        out
    }
}

/// Verse l'état courant dans vos fichiers, en 3MF.
///
/// Un objet modifié retourne auprès de celui dont il est issu, un objet créé
/// dans le dossier choisi à la création ; si ce dossier a disparu, il atterrit
/// dans les téléchargements plutôt que de se perdre.
pub fn save_to_files(id: &str) -> Result<String> {
    let c = get(id)?;
    if !current(id).is_file() {
        return Err(anyhow!("aucun objet à enregistrer pour l'instant"));
    }
    let (home, stem) = if c.is_creation() {
        (c.dest_dir.clone().map(PathBuf::from), slug(&c.title))
    } else {
        let src = PathBuf::from(&c.source);
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "objet".into());
        (src.parent().map(PathBuf::from), stem)
    };
    let dir = home
        .filter(|d| d.is_dir())
        .or_else(dirs::download_dir)
        .ok_or_else(|| anyhow!("aucun dossier où écrire"))?;
    let dst = free_name(&dir, &stem);
    stl_to_3mf(&current(id), &dst, &stem)?;

    let mut c = c;
    c.saved = Some(dst.to_string_lossy().to_string());
    c.updated_at = now();
    save(&c)?;
    Ok(dst.to_string_lossy().to_string())
}

// ------------------------------------------------------------ versions

#[derive(Serialize, Clone)]
pub struct Version {
    pub n: u32,
    pub at: u64,
    pub bytes: u64,
}

fn versions_dir(id: &str) -> PathBuf {
    workspace(id).join("versions")
}

/// Les versions enregistrées, de la première à la dernière.
pub fn versions(id: &str) -> Vec<Version> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(versions_dir(id)) else {
        return out;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(n) = name
            .strip_prefix('v')
            .and_then(|s| s.strip_suffix(".stl"))
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let meta = e.metadata().ok();
        out.push(Version {
            n,
            at: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
            bytes: meta.map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by_key(|v| v.n);
    out
}

/// Empreinte du contenu d'un fichier, pour ne pas archiver deux fois la même
/// chose — un enregistrement sans modification arrive plus souvent qu'on croit.
fn hash_file(p: &Path) -> Option<u64> {
    let data = std::fs::read(p).ok()?;
    Some(crate::util::fnv1a(&[&data]))
}

/// Archive l'état courant sous le numéro suivant.
fn capture(id: &str) -> Result<u32> {
    let cur = current(id);
    let n = versions(id).last().map(|v| v.n).unwrap_or(0) + 1;
    std::fs::copy(&cur, versions_dir(id).join(format!("v{n}.stl")))?;
    if let Ok(mut c) = get(id) {
        c.version = n;
        c.updated_at = now();
        let _ = save(&c);
    }
    Ok(n)
}

/// Remet une version antérieure en état courant.
///
/// La surveillance en est informée : ce retour en arrière ne doit pas créer
/// une version de plus, sinon l'historique gonflerait à chaque aller-retour.
pub fn revert(id: &str, n: u32) -> Result<()> {
    let src = versions_dir(id).join(format!("v{n}.stl"));
    if !src.is_file() {
        return Err(anyhow!("version {n} introuvable"));
    }
    std::fs::copy(&src, current(id))?;
    if let Some(h) = hash_file(&current(id)) {
        if let Some(w) = watchers().lock().unwrap().get(id) {
            *w.last.lock().unwrap() = h;
        }
    }
    if let Ok(mut c) = get(id) {
        c.version = n;
        c.updated_at = now();
        let _ = save(&c);
    }
    Ok(())
}

// ------------------------------------------------------------ surveillance

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

struct Watcher {
    stop: Arc<AtomicBool>,
    /// Empreinte du dernier maillage pris en compte.
    last: Arc<Mutex<u64>>,
    /// Numéro d'ordre : un veilleur ne retire que sa propre inscription, sans
    /// quoi il effacerait celle de son successeur en s'arrêtant.
    token: u64,
}

fn next_token() -> u64 {
    use std::sync::atomic::AtomicU64;
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}


fn watchers() -> &'static Mutex<HashMap<String, Watcher>> {
    static W: OnceLock<Mutex<HashMap<String, Watcher>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
struct MeshEvent {
    id: String,
    version: u32,
    stats: crate::mesh::Stats,
}

/// Chemin du maillage courant et empreinte de sa dernière écriture.
///
/// Cette empreinte sert de brise-cache à l'affichage : l'adresse du maillage ne
/// change jamais, et sans elle le visualiseur resservirait l'objet précédent.
/// On la tire du fichier lui-même, et non du numéro de version, qui n'avance
/// que lorsqu'un veilleur tourne.
#[derive(Serialize)]
pub struct CurrentDto {
    pub path: String,
    pub stamp: String,
}

pub fn current_dto(id: &str) -> Result<CurrentDto> {
    let p = current(id);
    let m = std::fs::metadata(&p)?;
    let secs = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(CurrentDto {
        path: p.to_string_lossy().to_string(),
        stamp: format!("{secs}-{}", m.len()),
    })
}

/// Lit l'état courant et en tire ses mesures.
pub fn current_stats(id: &str) -> Result<crate::mesh::Stats> {
    Ok(crate::mesh::stats(&crate::stl::read(&current(id))?))
}

/// Surveille le dossier de sortie d'une conversation.
///
/// Un script écrit rarement son fichier d'un coup : on attend donc que le
/// dossier se taise avant de lire, sans quoi on tomberait sur un maillage
/// tronqué au milieu de son écriture.
pub fn watch_start(app: tauri::AppHandle, id: &str) -> Result<()> {
    if watchers().lock().unwrap().contains_key(id) {
        return Ok(());
    }
    let out = workspace(id).join("out");
    if !out.is_dir() {
        return Err(anyhow!("dossier de sortie introuvable"));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let last = Arc::new(Mutex::new(hash_file(&current(id)).unwrap_or(0)));
    let token = next_token();
    watchers().lock().unwrap().insert(
        id.to_string(),
        Watcher {
            stop: stop.clone(),
            last: last.clone(),
            token,
        },
    );

    let id = id.to_string();
    std::thread::spawn(move || {
        watch_loop(&app, &id, &out, &stop, &last);
        // Le successeur éventuel porte un autre jeton : on ne touche qu'au sien.
        let mut m = watchers().lock().unwrap();
        if m.get(&id).map(|w| w.token) == Some(token) {
            m.remove(&id);
        }
    });
    Ok(())
}

/// Ce qu'il advient d'un remous dans le dossier de sortie.
enum Change {
    /// Nouvel état archivé : numéro de version et mesures.
    Archived(u32, crate::mesh::Stats),
    /// Rien de neuf — souvent une écriture qui n'a rien changé.
    Nothing,
    /// Fichier illisible : probablement une écriture en cours.
    TryAgain,
}

/// Décide du sort d'un changement, sans rien émettre.
fn consider(id: &str, last: &Mutex<u64>) -> Change {
    let Some(h) = hash_file(&current(id)) else {
        return Change::Nothing;
    };
    if h == *last.lock().unwrap() {
        return Change::Nothing;
    }
    let Ok(stats) = current_stats(id) else {
        return Change::TryAgain;
    };
    *last.lock().unwrap() = h;
    match capture(id) {
        Ok(v) => {
            // Rendus après l'archivage : Claude les trouvera à jour dès qu'il
            // voudra regarder ce qu'il vient de faire.
            let _ = write_previews(id);
            Change::Archived(v, stats)
        }
        Err(_) => Change::Nothing,
    }
}

fn watch_loop(
    app: &tauri::AppHandle,
    id: &str,
    out: &Path,
    stop: &AtomicBool,
    last: &Mutex<u64>,
) {
    {
        use notify::{RecursiveMode, Watcher as _};
        let (tx, rx) = std::sync::mpsc::channel();
        let Ok(mut w) = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) else {
            return;
        };
        if w.watch(out, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        let quiet = std::time::Duration::from_millis(300);
        let mut pending: Option<std::time::Instant> = None;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(_) => pending = Some(std::time::Instant::now()),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            let Some(t) = pending else { continue };
            if t.elapsed() < quiet {
                continue;
            }
            pending = None;

            let (version, stats) = match consider(id, last) {
                Change::Archived(v, s) => (v, s),
                Change::Nothing => continue,
                // Un maillage illisible signifie souvent une écriture en cours :
                // on laisse passer, le prochain remous le rattrapera.
                Change::TryAgain => {
                    pending = Some(std::time::Instant::now());
                    continue;
                }
            };
            let _ = app.emit(
                "ia-mesh",
                MeshEvent {
                    id: id.to_string(),
                    version,
                    stats,
                },
            );
        }
    }
}

pub fn watch_stop(id: &str) {
    if let Some(w) = watchers().lock().unwrap().remove(id) {
        w.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod watch_tests {
    use notify::{RecursiveMode, Watcher as _};
    use std::time::{Duration, Instant};

    /// Mesure le délai réel entre une écriture et son signalement.
    ///
    /// Sur macOS la surveillance passe par FSEvents, qui regroupe les
    /// évènements : si ce délai dépassait la seconde, « l'objet change sous vos
    /// yeux » deviendrait « l'objet change, un jour ».
    #[test]
    fn the_file_system_reports_quickly() {
        let dir = std::env::temp_dir().join("snapstudio-watch-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        let mut w = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .unwrap();
        w.watch(&dir, RecursiveMode::NonRecursive).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        let t0 = Instant::now();
        std::fs::write(dir.join("current.stl"), b"peu importe").unwrap();
        let got = rx.recv_timeout(Duration::from_secs(5));
        let delay = t0.elapsed();
        assert!(got.is_ok(), "aucun évènement reçu en 5 s");
        println!("évènement reçu en {} ms", delay.as_millis());
        assert!(
            delay < Duration::from_secs(2),
            "trop lent : {} ms",
            delay.as_millis()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn the_session_path_matches_claudes_naming() {
        let id = "b703e739-e760-4642-89a6-881a754d420c";
        let p = session_file(id);
        let dir = p.parent().unwrap().file_name().unwrap().to_string_lossy();
        assert!(dir.starts_with('-'), "le chemin absolu commence par un tiret");
        assert!(dir.contains("-config-snap-studio-ia-"), "obtenu : {dir}");
        assert!(dir.ends_with("-workspace"), "obtenu : {dir}");
        assert!(dir.contains(id), "l'identifiant apparaît tel quel");
        assert_eq!(p.file_name().unwrap().to_string_lossy(), format!("{id}.jsonl"));
    }

    /// Une conversation ouverte puis refermée sans un mot ne laisse aucune
    /// session : c'est exactement le cas qui faisait échouer la reprise.
    #[test]
    fn no_exchange_means_nothing_to_resume() {
        assert!(!has_session("00000000-0000-4000-8000-000000000000"));
    }
}

#[cfg(test)]
mod sortie_tests {
    use super::*;

    fn cube_3mf(dst: &Path) {
        crate::write3mf::write_scene(
            dst,
            &[SceneObject {
                name: "cube".into(),
                tris: crate::stl::tests_cube(),
                transform: Mat::IDENTITY,
                extruder: None,
            }],
        )
        .unwrap();
    }

    #[test]
    fn saving_lands_next_to_the_source_without_overwriting() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-sortie");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("support.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();

        let first = save_to_files(&c.id).unwrap();
        assert_eq!(
            Path::new(&first).file_name().unwrap(),
            "support-ia.3mf",
            "l'objet retourne auprès du sien"
        );
        assert_eq!(get(&c.id).unwrap().saved.as_deref(), Some(first.as_str()));
        assert_eq!(mesh_of_3mf(Path::new(&first)).unwrap().tris.len(), 12);

        // Un second enregistrement ne doit pas écraser le premier.
        let second = save_to_files(&c.id).unwrap();
        assert_eq!(Path::new(&second).file_name().unwrap(), "support-ia-2.3mf");
        assert!(Path::new(&first).is_file(), "le premier est toujours là");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn previews_are_written_and_refreshed() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-apercu");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("cube.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();

        for (name, _) in VIEWS {
            let p = previews_dir(&c.id).join(format!("{name}.png"));
            assert!(p.is_file(), "{name}.png manquant");
            assert!(std::fs::metadata(&p).unwrap().len() > 500);
        }

        // Une conversation d'avant les aperçus les retrouve à l'ouverture.
        std::fs::remove_dir_all(previews_dir(&c.id)).unwrap();
        std::fs::write(workspace(&c.id).join("CLAUDE.md"), "vieilles consignes").unwrap();
        refresh_workspace(&c.id);
        assert!(previews_dir(&c.id).join("dessus.png").is_file());
        let md = std::fs::read_to_string(workspace(&c.id).join("CLAUDE.md")).unwrap();
        assert!(md.contains("apercu/"), "les consignes ont été remises à jour");
        assert!(md.contains("12 triangles"), "compte lu dans l'en-tête du STL");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
