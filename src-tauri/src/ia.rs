//! The AI tab's conversations.
//!
//! Each conversation owns its folder, and that folder is its identity: the
//! folder name is also Claude Code's `--session-id`. Resuming then becomes
//! deterministic — there is never any need to dig into Claude's history or to
//! guess which session belongs to which object.
//!
//! ```text
//! ~/.config/snap-studio/ia/<uuid>/
//!   meta.json
//!   workspace/          ← mounted in the container
//!     CLAUDE.md  source.stl  tools/  out/current.stl  versions/v1.stl
//! ```
//!
//! A conversation may also start from nothing, to design an object: then there
//! is no `source.stl`, and `out/current.stl` only exists after the first export.
//!
//! The working folder belongs to Claude; the app only writes there at creation,
//! then just watches what comes out.

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
    /// UUID v4: folder name and Claude session id.
    pub id: String,
    pub title: String,
    /// Path of the original 3MF, as it was at creation.
    pub source: String,
    pub source_name: String,
    /// Initial request, sent on the first pass in the terminal.
    #[serde(default)]
    pub prompt: String,
    /// "container" or "local".
    pub engine: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// Number of the version shown.
    #[serde(default = "one")]
    pub version: u32,
    /// Path of the 3MF exported into your files, once the work is done.
    #[serde(default)]
    pub saved: Option<String>,
    /// True as soon as the Claude session was created: it is resumed afterwards.
    #[serde(default)]
    pub started: bool,
    /// "create" for an object designed from scratch, empty for a modification.
    #[serde(default)]
    pub kind: String,
    /// Folder where the created object goes; a modification goes back next to
    /// its original.
    #[serde(default)]
    pub dest_dir: Option<String>,
    /// Maximum size asked for a created object, in millimeters.
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

// ------------------------------------------------------------ locations

/// `~/.config/snap-studio/ia`, and not the system's preferences folder.
///
/// This path is mounted as is in the container: it must stay short and
/// without spaces, which "Application Support" does not allow.
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

/// The mesh the app shows: what Claude produced last.
pub fn current(id: &str) -> PathBuf {
    workspace(id).join("out").join("current.stl")
}

fn meta_path(id: &str) -> PathBuf {
    dir(id).join("meta.json")
}

// ------------------------------------------------------------ store

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

/// The conversations, from the most recently active to the oldest.
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

/// A valid id is the UUID we generated, nothing else.
///
/// Comparing paths is not enough: `..` stays under the root lexically, and it
/// is the kernel that resolves it afterwards — a deletion would then reach
/// much further than intended.
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

pub fn remove(id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(anyhow!("unknown conversation"));
    }
    std::fs::remove_dir_all(dir(id))?;
    Ok(())
}

/// Notes that a Claude session now exists for this conversation.
pub fn mark_started(id: &str) {
    if let Ok(mut c) = get(id) {
        c.started = true;
        c.updated_at = now();
        let _ = save(&c);
    }
}


/// Where Claude Code stores the session of a working folder.
///
/// It names the folder after the path, each character that is neither a letter
/// nor a digit becoming a dash: `/Users/me/.config/snap-studio/ia/<id>/workspace`
/// gives `-Users-me--config-snap-studio-ia-<id>-workspace`.
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

/// True if Claude really has a session to resume.
///
/// Also holds in the container, which was checked on a machine: yolobox mounts
/// the working folder at its real path, and `--claude-config` shares
/// `~/.claude/projects`. A conversation held in the sandbox therefore leaves
/// its session at this exact place, on the host.
///
/// Our own flag is not trusted: opening the terminal does not create a
/// session, only a first exchange does. Someone who opens a conversation then
/// closes it without a word leaves no trace, and a resume would then fail on
/// "No conversation found with session ID".
pub fn has_session(id: &str) -> bool {
    session_file(id).is_file()
}

// ------------------------------------------------------------ conversions

/// Full geometry of a 3MF, without sampling.
///
/// The viewer makes do with a triangle budget: the preview stays faithful. For
/// a conversion, however, everything must be kept.
pub fn mesh_of_3mf(path: &Path) -> Result<MeshData> {
    let mut zip = crate::model3mf::open(path)?;
    crate::mesh::load_mesh(&mut zip, usize::MAX)
}

/// Converts the original 3MF to STL in the working folder.
pub fn source_to_stl(src: &Path, dst: &Path) -> Result<usize> {
    let m = mesh_of_3mf(src)?;
    crate::stl::write(dst, &m.tris)?;
    Ok(m.tris.len())
}

/// Converts an STL back to 3MF, ready to slice.
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

// ------------------------------------------------------------ creation

/// Readable title from the request, otherwise from the file name.
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
        .unwrap_or_else(|| crate::t!("ia.untitled"))
}

/// Prepares a conversation: folder, instructions, tools, converted object.
pub fn create(source: &Path, prompt: &str, engine: &str) -> Result<Conversation> {
    if !source.is_file() {
        return Err(anyhow!(crate::t!("err.file_not_found")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ws = workspace(&id);
    std::fs::create_dir_all(ws.join("out"))?;
    std::fs::create_dir_all(ws.join("versions"))?;

    // Conversion first: if the object is unreadable, nothing must remain.
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
    std::fs::write(ws.join("CLAUDE.md"), instructions(&name, tris))?;
    write_tools(&ws)?;

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

/// Prepares a conversation without a starting object: Claude designs the part.
///
/// The output folder exists from the start — the watch hooks onto it — but
/// stays empty: the first exported mesh becomes v1.
pub fn create_blank(
    prompt: &str,
    engine: &str,
    dest_dir: &Path,
    bounds: Option<[f32; 3]>,
) -> Result<Conversation> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(anyhow!(crate::t!("ia.new.need_prompt")));
    }
    if !dest_dir.is_dir() {
        return Err(anyhow!(crate::t!("err.no_dest")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ws = workspace(&id);
    std::fs::create_dir_all(ws.join("out"))?;
    std::fs::create_dir_all(ws.join("versions"))?;
    std::fs::write(ws.join("CLAUDE.md"), instructions_creation(bounds))?;
    write_tools(&ws)?;

    let c = Conversation {
        id,
        title: title_for(prompt, Path::new(&crate::t!("ia.new_object"))),
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

// ------------------------------------------------------------ workspace layout

/// Folder of the tools the app leaves to Claude.
const TOOLS: &str = "tools";
/// Measurement tool, and the one that installs a mesh as the current state.
const MEASURE: &str = "measure.py";
const EXPORT: &str = "export.py";

/// Writes (or refreshes) the tools of a working folder.
fn write_tools(ws: &Path) -> Result<()> {
    std::fs::create_dir_all(ws.join(TOOLS))?;
    std::fs::write(ws.join(TOOLS).join(MEASURE), MEASURE_PY)?;
    std::fs::write(ws.join(TOOLS).join(EXPORT), EXPORT_PY)?;
    Ok(())
}

/// The language Claude must answer in: the app's, named in English.
fn reply_language() -> &'static str {
    match crate::i18n::lang().as_str() {
        "fr" => "French",
        _ => "English",
    }
}

/// The instructions left to Claude in the working folder.
fn instructions(source_name: &str, tris: usize) -> String {
    let lang = reply_language();
    format!(
        "# Modifying a part to print

You work on **{source_name}**, converted to STL for this session. What you
write shows live in the app, next to this conversation.

**Always answer the user in {lang}.**

## Look before acting

The `preview/` folder holds three renders of the current state — `front.png`,
`three-quarter.png`, `top.png` — that the app renders again after **every**
change you save.

Open them. They are your only way to see the part: an off-center hole, a wall
that goes through, a part resting askew do not show in the coordinates. Look
before changing, and look again afterwards.

## The files

- `source.stl` — the original object. **Never modify it.**
- `out/current.stl` — the current state, the one shown on screen.
- `preview/` — the three renders. Read-only, the app writes them.
- `versions/` — the history, managed by the app. Do not touch it.
- `tools/measure.py` — dimensions, volume, watertightness.
- `tools/export.py` — checks a mesh and installs it as the current state.

## How to proceed

1. `python3 tools/measure.py` then look at `preview/three-quarter.png`.
2. Write a Python transformation script, with `trimesh`.
3. Install the result: `python3 tools/export.py result.stl`
4. Look at the previews again, and start over if it is not right.

## What matters

- Units are **millimeters**, the Z axis is the height, and the part rests on
  `z = 0`. After a rotation, put it back on the ground.
- The mesh must stay **watertight**: otherwise slicing will fail.
- Always start from `out/current.stl`, never from `source.stl`, to chain
  several changes.
- Move in small checkable steps rather than one big script.
- If a request is ambiguous — which side, which face, which dimension — ask
  rather than guess.

The original object has {tris} triangles.

## Available tools

`trimesh`, `manifold3d` (booleans), `numpy`. No Blender.
"
    )
}

/// The instructions of a conversation that starts from nothing.
fn instructions_creation(bounds: Option<[f32; 3]>) -> String {
    let lang = reply_language();
    let fmt = |v: f32| format!("{v:.0}");
    let envelope = match bounds {
        Some([x, y, z]) => format!(
            "The part must fit in **{} × {} × {} mm** (X × Y × Z): it is the
  printable volume asked for. Check it with `tools/measure.py` at each export.",
            fmt(x),
            fmt(y),
            fmt(z)
        ),
        None => "No size limit is imposed; stay reasonable and ask if the size
  is not clear."
            .into(),
    };
    format!(
        "# Creating a part to print

You design a part **from scratch**, from the user's description. What you
export shows live in the app, next to this conversation.

**Always answer the user in {lang}.**

## Before modeling

If a dimension, a use or a constraint is missing — screw diameter, thickness,
bearing side — **ask** rather than guess. Then announce in a few lines what you
are going to build: base shapes, main dimensions, print orientation.

## The files

- `out/current.stl` — the current state, the one shown on screen. It does not
  exist yet: your first export creates it.
- `preview/` — three renders of the current state (`front.png`,
  `three-quarter.png`, `top.png`), rendered again by the app after **every**
  export. Read-only.
- `versions/` — the history, managed by the app. Do not touch it.
- `tools/measure.py` — dimensions, volume, watertightness.
- `tools/export.py` — checks a mesh and installs it as the current state.

## How to proceed

1. Write a Python script, `model.py`, that builds the part with `trimesh`
   (primitives: boxes, cylinders, profile extrusions) and `manifold3d` for
   booleans. Keep the dimensions as named variables at the top of the script:
   they will be revisited.
2. Install the result: `python3 tools/export.py result.stl`
3. Open `preview/three-quarter.png` and run `python3 tools/measure.py`.
4. Fix and start again; each export becomes a new version.

The previews are your only way to see the part: an off-center hole, a wall that
goes through do not show in the coordinates. Look after each export.

## What matters

- Units are **millimeters**, the Z axis is the height, and the part rests on
  `z = 0`, centered in X and Y.
- {envelope}
- The mesh must be **watertight**: otherwise slicing will fail.
- Think FDM printing: a large flat face on the ground, overhangs under 45°,
  walls of at least 1.2 mm, 0.2 to 0.3 mm of clearance between two parts that
  fit together.
- Move in small checkable steps rather than one big script.

## Available tools

`trimesh`, `manifold3d` (booleans), `numpy`. No Blender, no OpenSCAD.
"
    )
}

const MEASURE_PY: &str = r#"#!/usr/bin/env python3
"""Dimensions, volume and health of a mesh."""
import sys
import trimesh

path = sys.argv[1] if len(sys.argv) > 1 else "out/current.stl"
m = trimesh.load(path, force="mesh")
x, y, z = m.extents
print(f"file       : {path}")
print(f"dimensions : {x:.2f} x {y:.2f} x {z:.2f} mm")
print(f"minimum    : {m.bounds[0].round(2).tolist()}")
print(f"maximum    : {m.bounds[1].round(2).tolist()}")
print(f"volume     : {m.volume / 1000:.2f} cm3")
print(f"faces      : {len(m.faces)}")
print(f"watertight : {'yes' if m.is_watertight else 'NO'}")
if not m.is_watertight:
    print("warning    : a mesh that is not watertight will not slice")
"#;

const EXPORT_PY: &str = r#"#!/usr/bin/env python3
"""Checks a mesh then installs it as the current state.

    python3 tools/export.py result.stl
"""
import shutil
import sys
import trimesh

if len(sys.argv) < 2:
    sys.exit("usage: export.py <file.stl>")

src = sys.argv[1]
m = trimesh.load(src, force="mesh")
if len(m.faces) == 0:
    sys.exit("refused: empty mesh")
if not m.is_watertight:
    print("warning: mesh not watertight, slicing may fail")

shutil.copyfile(src, "out/current.stl")
x, y, z = m.extents
print(f"installed: {x:.2f} x {y:.2f} x {z:.2f} mm, {len(m.faces)} faces")
print("the previews are rendered again: look at preview/three-quarter.png")
"#;

// ------------------------------------------------------------ tooling

#[derive(Serialize)]
pub struct Engine {
    /// The `docker` binary is installed.
    pub docker: bool,
    /// The daemon answers — installed does not mean started.
    pub daemon: bool,
    pub yolobox: bool,
    pub claude: bool,
}

/// Does the Docker daemon answer?
///
/// A client installed without an active daemon is the most common case on
/// macOS, where one is installed with `brew` and the other started by hand.
/// Without this check, the app would offer a sandbox that would fail.
///
/// The wait is bounded: a missing socket answers at once, but a daemon
/// starting up can keep one waiting forever.
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

/// What is installed — and usable — on the machine.
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

        let c = create(&src, "Tilt the top by 15°", "local").unwrap();
        let ws = workspace(&c.id);
        for f in [
            "CLAUDE.md",
            "source.stl",
            "tools/measure.py",
            "tools/export.py",
            "out/current.stl",
            "versions/v1.stl",
        ] {
            assert!(ws.join(f).exists(), "{f} should exist");
        }
        assert_eq!(c.title, "Tilt the top by 15°");
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
            assert!((a.min[k] - b.min[k]).abs() < 1e-4, "box kept");
            assert!((a.max[k] - b.max[k]).abs() < 1e-4, "box kept");
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

        assert_eq!(versions(&c.id).len(), 1, "the original is version 1");

        // Claude writes a different object: one face less.
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10);
        crate::stl::write(&current(&c.id), &tris).unwrap();
        assert_eq!(capture(&c.id).unwrap(), 2);
        assert_eq!(versions(&c.id).len(), 2);
        assert_eq!(get(&c.id).unwrap().version, 2);
        assert_eq!(crate::stl::read(&current(&c.id)).unwrap().tris.len(), 10);

        // Going back: the current state becomes the original again.
        revert(&c.id, 1).unwrap();
        assert_eq!(crate::stl::read(&current(&c.id)).unwrap().tris.len(), 12);
        assert_eq!(get(&c.id).unwrap().version, 1);
        assert_eq!(versions(&c.id).len(), 2, "going back archives nothing");
        assert!(revert(&c.id, 9).is_err(), "version that does not exist");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_file(&src);
    }

    /// The core of the watch, without window nor thread: what deserves to be
    /// archived, and what does not.
    #[test]
    fn only_real_changes_are_archived() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("veille.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();
        let last = Mutex::new(hash_file(&current(&c.id)).unwrap());

        // Nothing moved.
        assert!(matches!(consider(&c.id, &last), Change::Nothing));

        // Claude writes a different object.
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10);
        crate::stl::write(&current(&c.id), &tris).unwrap();
        let Change::Archived(v, stats) = consider(&c.id, &last) else {
            panic!("the change should have been archived");
        };
        assert_eq!(v, 2);
        assert_eq!(stats.triangles, 10);
        assert_eq!(stats.watertight, Some(false));

        // Writing the same content again must not create one more version.
        crate::stl::write(&current(&c.id), &tris).unwrap();
        assert!(matches!(consider(&c.id, &last), Change::Nothing));
        assert_eq!(versions(&c.id).len(), 2);

        // A file truncated mid-write: come back later.
        std::fs::write(current(&c.id), b"a half-written file").unwrap();
        assert!(matches!(consider(&c.id, &last), Change::TryAgain));
        assert_eq!(versions(&c.id).len(), 2, "nothing was archived meanwhile");

        // And going back does not trigger archiving again.
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

    /// A forged id must not be able to climb out of the store: ".." stays
    /// under the root lexically, but not for the kernel.
    #[test]
    fn refuses_a_path_outside_the_store() {
        for bad in ["..", ".", "", "../evasion", "a/b", "../../Documents", "\u{e9}"] {
            assert!(remove(bad).is_err(), "“{bad}” should have been refused");
        }
        assert!(root().is_dir(), "the store is still there");
        assert!(valid_id("b703e739-e760-4642-89a6-881a754d420c"));
        assert!(!valid_id("b703e739-e760-4642-89a6-881a754d420"), "too short");
    }

    #[test]
    fn a_blank_conversation_starts_without_an_object() {
        let dest = std::env::temp_dir().join("snapstudio-ia-blank");
        std::fs::create_dir_all(&dest).unwrap();
        assert!(create_blank("  ", "local", &dest, None).is_err(), "description required");

        let c = create_blank("Wall hook for headphones", "local", &dest, Some([270.0, 270.0, 270.0]))
            .unwrap();
        let ws = workspace(&c.id);
        assert!(c.is_creation());
        assert_eq!(c.version, 0);
        assert!(ws.join("out").is_dir(), "the watch needs the folder");
        assert!(!current(&c.id).exists());
        assert!(!ws.join("source.stl").exists());
        let md = std::fs::read_to_string(ws.join("CLAUDE.md")).unwrap();
        assert!(md.contains("270 × 270 × 270 mm"));
        assert!(save_to_files(&c.id).is_err(), "nothing to save before the first export");

        // First export: v1 appears, and the object goes to the chosen folder.
        let tris = crate::stl::tests_cube();
        crate::stl::write(&current(&c.id), &tris).unwrap();
        let last = Mutex::new(0);
        assert!(matches!(consider(&c.id, &last), Change::Archived(1, _)));
        assert!(previews_dir(&c.id).join("three-quarter.png").is_file());
        let out = save_to_files(&c.id).unwrap();
        assert_eq!(Path::new(&out).parent(), Some(dest.as_path()));
        assert!(out.ends_with("wall-hook-for-headphones-ai.3mf"), "{out}");
        std::fs::remove_file(&out).unwrap();
        remove(&c.id).unwrap();
    }

    #[test]
    fn slugs_make_tidy_file_names() {
        assert_eq!(slug("Wall hook, 60 mm"), "wall-hook-60-mm");
        assert_eq!(slug("Boîte à vis…"), "boîte-à-vis");
        assert_eq!(slug("  !!  "), "object");
    }

    #[test]
    fn title_falls_back_on_the_file_name() {
        let p = PathBuf::from("/tmp/support-v2.3mf");
        assert_eq!(title_for("", &p), "support-v2");
        assert_eq!(title_for("  Drill a hole  ", &p), "Drill a hole");
        let long = "a".repeat(80);
        assert_eq!(title_for(&long, &p).chars().count(), 61, "truncated with an ellipsis");
    }
}

#[cfg(test)]
mod essai_reel {
    use super::*;

    /// Prepares a real conversation from a 3MF on disk.
    ///
    /// `IA_3MF=/path/object.3mf cargo test essai_reel -- --nocapture`
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
        assert_eq!(stl.tris.len(), orig.tris.len(), "no triangle lost");
        for k in 0..3 {
            assert!((stl.min[k] - orig.min[k]).abs() < 1e-3);
            assert!((stl.max[k] - orig.max[k]).abs() < 1e-3);
        }

        // And the way back to 3MF must stay faithful.
        let back = ws.join("retour.3mf");
        stl_to_3mf(&ws.join("out/current.stl"), &back, "object").unwrap();
        let round = mesh_of_3mf(&back).unwrap();
        assert_eq!(round.tris.len(), orig.tris.len());
        println!("round trip checked, folder: {}", ws.display());

        // The previews: what Claude will open to look at its work.
        write_previews(&c.id).unwrap();
        if let Ok(dest) = std::env::var("IA_PNG") {
            std::fs::create_dir_all(&dest).unwrap();
            for (name, _) in VIEWS {
                let from = previews_dir(&c.id).join(format!("{name}.png"));
                let bytes = std::fs::metadata(&from).unwrap().len();
                assert!(bytes > 2000, "{name}.png is {bytes} bytes");
                std::fs::copy(&from, std::path::Path::new(&dest).join(format!("{name}.png")))
                    .unwrap();
                println!("preview {name}: {bytes} bytes");
            }
        }

        // And the way back into the user's files.
        let saved = save_to_files(&c.id).unwrap();
        println!("saved: {saved}");
        assert!(std::path::Path::new(&saved).is_file());
        assert_eq!(get(&c.id).unwrap().saved.as_deref(), Some(saved.as_str()));
        let back = mesh_of_3mf(std::path::Path::new(&saved)).unwrap();
        assert_eq!(back.tris.len(), orig.tris.len(), "the 3MF returned is complete");
        std::fs::remove_file(&saved).unwrap();

        remove(&c.id).unwrap();
    }
}


// ------------------------------------------------------------ sandbox

/// Dockerfile fragment added to the sandbox image.
///
/// Deliberately light: trimesh covers booleans, measurements and repairs,
/// which is enough to touch up a part. Blender would come here the day a
/// request really needs it.
const DOCKERFILE: &str = "\
# Modeling tools for Snap Studio's AI conversations.
#
# Installed as administrator, so system-wide: the container's home folder is
# covered by a volume at run time, and anything put there at build time would
# disappear.
USER root
RUN pip3 install --no-cache-dir --break-system-packages \\
      trimesh manifold3d numpy
USER yolo
";

/// The fragment on disk, written if missing.
///
/// It is shared by all conversations: the sandbox is only built once, and the
/// following ones start at once.
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

// ------------------------------------------------------------ previews

/// The three views Claude can open to look at its work. The top view is
/// deliberately tilted by about twenty degrees: straight from above, all top
/// faces look the same and relief vanishes — a 0.5 mm engraving rendered a
/// uniform disc.
const VIEWS: [(&str, [f32; 3]); 3] = [
    ("front", [0.0, -1.0, 0.12]),
    (THREE_QUARTER, [0.62, -1.0, 0.68]),
    ("top", [0.0, -0.36, 1.0]),
];
/// The view that also serves as the thumbnail of a created object.
const THREE_QUARTER: &str = "three-quarter";

/// Triangle budget for a preview: the silhouette gains nothing beyond it, and
/// a dense mesh would cost several seconds per view.
const PREVIEW_BUDGET: usize = 250_000;

/// Puts the render on a dark background.
///
/// Parts are light and the render lights them up to white: on a white
/// background the silhouette fades and judging an outline becomes
/// impossible. A slate background keeps the shape readable whatever happens.
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
    workspace(id).join("preview")
}

/// Renders three views of the current state into `preview/`.
///
/// It is the piece that changes everything: without an image, Claude edits a
/// mesh blindly and cannot notice that a hole is off-center. It only has to
/// open these files with its reading tool.
///
/// They are written outside the watched folder, so as not to wake the watch
/// at each render.
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

/// The three-quarter view, for the thumbnail of a created object: it has no
/// original to take a thumbnail from.
pub fn preview_png(id: &str) -> Result<Vec<u8>> {
    if !valid_id(id) {
        return Err(anyhow!("unknown conversation"));
    }
    let png = previews_dir(id).join(format!("{THREE_QUARTER}.png"));
    // Conversations from before the English layout, until their next opening.
    let legacy = workspace(id).join("apercu").join("trois-quarts.png");
    Ok(std::fs::read(&png).or_else(|_| std::fs::read(legacy))?)
}

/// Brings what belongs to the app in a working folder up to date.
///
/// Instructions and tools improve from version to version: a conversation
/// opened two weeks ago must benefit, otherwise Claude would work with stale
/// instructions — and without previews, which did not always exist. The
/// language Claude answers in follows the app's at each opening.
pub fn refresh_workspace(id: &str) {
    let ws = workspace(id);
    if !ws.is_dir() {
        return;
    }
    let Ok(c) = get(id) else { return };
    let text = if c.is_creation() {
        instructions_creation(c.bounds)
    } else {
        let tris = crate::stl::count(&ws.join("source.stl")).unwrap_or(0);
        instructions(&c.source_name, tris)
    };
    let _ = std::fs::write(ws.join("CLAUDE.md"), text);
    let _ = write_tools(&ws);
    if current(id).is_file() && !previews_dir(id).join(format!("{THREE_QUARTER}.png")).is_file() {
        let _ = write_previews(id);
    }
}

// ------------------------------------------------------------ saving

/// Free name in a folder: `support-ai.3mf`, then `support-ai-2.3mf`.
fn free_name(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}-ai.3mf"));
    if !first.exists() {
        return first;
    }
    for n in 2..999 {
        let p = dir.join(format!("{stem}-ai-{n}.3mf"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-ai-{}.3mf", now()))
}

/// File name from a title: "Wall hook, 60 mm" → `wall-hook-60-mm`.
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
        "object".into()
    } else {
        out
    }
}

/// Saves the current state into your files, as 3MF.
///
/// A modified object goes back next to the one it came from, a created object
/// into the folder chosen at creation; if that folder has gone, it lands in
/// Downloads rather than get lost.
pub fn save_to_files(id: &str) -> Result<String> {
    let c = get(id)?;
    if !current(id).is_file() {
        return Err(anyhow!(crate::t!("err.nothing_to_save")));
    }
    let (home, stem) = if c.is_creation() {
        (c.dest_dir.clone().map(PathBuf::from), slug(&c.title))
    } else {
        let src = PathBuf::from(&c.source);
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "object".into());
        (src.parent().map(PathBuf::from), stem)
    };
    let dir = home
        .filter(|d| d.is_dir())
        .or_else(dirs::download_dir)
        .ok_or_else(|| anyhow!(crate::t!("err.nowhere_to_write")))?;
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

/// The saved versions, from the first to the last.
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

/// Fingerprint of a file's content, so as not to archive the same thing twice
/// — a save without changes happens more often than one thinks.
fn hash_file(p: &Path) -> Option<u64> {
    let data = std::fs::read(p).ok()?;
    Some(crate::util::fnv1a(&[&data]))
}

/// Archives the current state under the next number.
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

/// Makes an earlier version the current state.
///
/// The watch is told: this going back must not create one more version,
/// otherwise the history would swell at every round trip.
pub fn revert(id: &str, n: u32) -> Result<()> {
    let src = versions_dir(id).join(format!("v{n}.stl"));
    if !src.is_file() {
        return Err(anyhow!(crate::t!("err.no_version", n = n)));
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

// ------------------------------------------------------------ watching

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

struct Watcher {
    stop: Arc<AtomicBool>,
    /// Fingerprint of the last mesh taken into account.
    last: Arc<Mutex<u64>>,
    /// Sequence number: a watcher only removes its own registration, otherwise
    /// it would erase its successor's when stopping.
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

/// Path of the current mesh and stamp of its last write.
///
/// The stamp busts the display cache: the mesh address never changes, and
/// without it the viewer would serve the previous object again. It is taken
/// from the file itself, not from the version number, which only advances
/// while a watcher runs.
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

/// Reads the current state and takes its measurements.
pub fn current_stats(id: &str) -> Result<crate::mesh::Stats> {
    Ok(crate::mesh::stats(&crate::stl::read(&current(id))?))
}

/// Watches a conversation's output folder.
///
/// A script rarely writes its file in one go: so wait until the folder goes
/// quiet before reading, otherwise we would hit a mesh truncated mid-write.
pub fn watch_start(app: tauri::AppHandle, id: &str) -> Result<()> {
    if watchers().lock().unwrap().contains_key(id) {
        return Ok(());
    }
    let out = workspace(id).join("out");
    if !out.is_dir() {
        return Err(anyhow!("output folder not found"));
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
        // The possible successor carries another token: only touch our own.
        let mut m = watchers().lock().unwrap();
        if m.get(&id).map(|w| w.token) == Some(token) {
            m.remove(&id);
        }
    });
    Ok(())
}

/// What becomes of a stir in the output folder.
enum Change {
    /// New state archived: version number and measurements.
    Archived(u32, crate::mesh::Stats),
    /// Nothing new — often a write that changed nothing.
    Nothing,
    /// Unreadable file: probably a write in progress.
    TryAgain,
}

/// Decides the fate of a change, without emitting anything.
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
            // Renders after archiving: Claude will find them up to date as soon as it
            // wants to look at what it just did.
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
                // An unreadable mesh often means a write in progress: let it go, the next
                // stir will catch it.
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

    /// Measures the real delay between a write and its notification.
    ///
    /// On macOS the watch goes through FSEvents, which batches events: if this
    /// delay went beyond a second, "the object changes before your eyes" would
    /// become "the object changes, some day".
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
        assert!(got.is_ok(), "no event received within 5 s");
        println!("event received in {} ms", delay.as_millis());
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
        assert!(dir.starts_with('-'), "the absolute path starts with a dash");
        assert!(dir.contains("-config-snap-studio-ia-"), "obtenu : {dir}");
        assert!(dir.ends_with("-workspace"), "obtenu : {dir}");
        assert!(dir.contains(id), "the id shows as is");
        assert_eq!(p.file_name().unwrap().to_string_lossy(), format!("{id}.jsonl"));
    }

    /// A conversation opened then closed without a word leaves no session: that
    /// is exactly the case that made resuming fail.
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
            "support-ai.3mf",
            "the object goes back next to its own"
        );
        assert_eq!(get(&c.id).unwrap().saved.as_deref(), Some(first.as_str()));
        assert_eq!(mesh_of_3mf(Path::new(&first)).unwrap().tris.len(), 12);

        // A second save must not overwrite the first.
        let second = save_to_files(&c.id).unwrap();
        assert_eq!(Path::new(&second).file_name().unwrap(), "support-ai-2.3mf");
        assert!(Path::new(&first).is_file(), "the first is still there");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn previews_are_written_and_refreshed() {
        let tmp = std::env::temp_dir().join("snapstudio-ia-preview");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("cube.3mf");
        cube_3mf(&src);
        let c = create(&src, "", "local").unwrap();

        for (name, _) in VIEWS {
            let p = previews_dir(&c.id).join(format!("{name}.png"));
            assert!(p.is_file(), "{name}.png missing");
            assert!(std::fs::metadata(&p).unwrap().len() > 500);
        }

        // A conversation from before the previews finds them when opened.
        std::fs::remove_dir_all(previews_dir(&c.id)).unwrap();
        std::fs::write(workspace(&c.id).join("CLAUDE.md"), "old instructions").unwrap();
        refresh_workspace(&c.id);
        assert!(previews_dir(&c.id).join("top.png").is_file());
        let md = std::fs::read_to_string(workspace(&c.id).join("CLAUDE.md")).unwrap();
        assert!(md.contains("preview/"), "the instructions were brought up to date");
        assert!(md.contains("12 triangles"), "count read from the STL header");

        remove(&c.id).unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
