//! Background slicing with the Snapmaker Orca engine.
//!
//! The engine runs headless: it receives complete configurations written by
//! [`crate::presets`], a geometry file, and returns a G-code. Nothing shows on
//! screen; the app stays in charge of the run.
//!
//! Two flags are essential and easy to forget: `--arrange 0`, without which
//! the engine rearranges the plate and ignores the requested placement, and
//! `--allow-newer-file`, without which it refuses projects saved by a newer
//! version than its own.

use crate::presets::{self, Index};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static INDEX: OnceLock<Mutex<Option<(PathBuf, Arc<Index>)>>> = OnceLock::new();

/// Preset inventory, read again only when the application changes (or a
/// user preset is saved).
fn index_for(app: &Path) -> Result<Arc<Index>> {
    let cell = INDEX.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if let Some((p, idx)) = guard.as_ref() {
        if p == app {
            return Ok(idx.clone());
        }
    }
    let idx = Arc::new(Index::build(app)?);
    *guard = Some((app.to_path_buf(), idx.clone()));
    Ok(idx)
}

/// Slicing engine: the one Snap Studio downloaded (`engine.rs`).
///
/// `SNAPSTUDIO_ENGINE` designates a specific engine (`.app`, executable or
/// `AppRun`): this is how the CI tries out a slimmed-down engine. While no
/// engine is referenced (development build), the installed Snapmaker Orca is
/// the fallback.
pub fn engine() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SNAPSTUDIO_ENGINE").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    if crate::engine::referenced() {
        return crate::engine::installed();
    }
    let list = crate::slicers::list();
    list.iter()
        .find(|s| s.name == "Snapmaker Orca")
        .or_else(|| list.first())
        .map(|s| PathBuf::from(&s.path))
}

/// Engine data folder (logs, cache): Snap Studio's own, so as never to write
/// into Snapmaker Orca's nor create one.
fn engine_datadir() -> PathBuf {
    let d = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio")
        .join("engine")
        .join("data");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn binary(app: &Path) -> Result<PathBuf> {
    crate::slicers::executable(app)
}

#[derive(Serialize, Clone)]
pub struct PresetLists {
    pub machines: Vec<presets::PresetDto>,
    pub processes: Vec<presets::PresetDto>,
    pub filaments: Vec<presets::PresetDto>,
    /// Presets selected in Snapmaker Orca.
    pub selected: std::collections::HashMap<String, String>,
    pub extruders: usize,
    pub engine: Option<String>,
    /// The machine's plates and the default one.
    pub bed_types: Vec<presets::BedType>,
    pub bed_type: String,
}

/// Effective content of a preset for the details sheet: what the engine will
/// receive, quick settings, plate and spool color included.
pub fn details(
    name: &str,
    machine: &str,
    simple: Option<Simple>,
    overrides: &Map<String, Value>,
    color: Option<&str>,
) -> Result<presets::Details> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let extra = match idx.kind_of(name) {
        Some(presets::Kind::Process) => {
            let mut o = simple.unwrap_or_default().to_overrides();
            for (k, v) in overrides {
                o.insert(k.clone(), v.clone());
            }
            presets::process_extra(&idx, machine, &o)
        }
        Some(presets::Kind::Filament) => presets::filament_extra(color),
        _ => Map::new(),
    };
    idx.details(name, &extra).ok_or_else(|| anyhow!(crate::t!("err.unknown_preset", name = name)))
}

/// Saves the effective settings (quick settings, then overrides) as a user
/// process preset inheriting `base`; the inventory is read again.
pub fn save_process(name: &str, base: &str, simple: Option<Simple>, overrides: &Map<String, Value>) -> Result<String> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let mut values = simple.unwrap_or_default().to_overrides();
    for (k, v) in overrides {
        // The plate is chosen per slice, not part of a process preset.
        if k != "curr_bed_type" {
            values.insert(k.clone(), v.clone());
        }
    }
    presets::save_user_process(&idx, name, base, &values)?;
    if let Some(cell) = INDEX.get() {
        *cell.lock().unwrap() = None;
    }
    Ok(name.trim().to_string())
}

/// Lists that can be offered, filtered for the requested machine.
pub fn lists(machine: Option<&str>) -> Result<PresetLists> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let machines = idx.machines();
    let chosen = machine
        .map(String::from)
        .or_else(|| idx.selected.get("machine").cloned())
        .filter(|m| machines.iter().any(|x| &x.name == m))
        .or_else(|| machines.first().map(|m| m.name.clone()))
        .ok_or_else(|| anyhow!(crate::t!("err.no_machine")))?;
    let (bed_types, bed_type) = idx.bed_types(&chosen);
    Ok(PresetLists {
        bed_types,
        bed_type,
        processes: idx.processes_for(&chosen),
        filaments: idx.filaments_for(&chosen),
        extruders: idx.extruder_count(&chosen),
        machines,
        selected: idx.selected.clone(),
        engine: Some(app.to_string_lossy().to_string()),
    })
}

/// Simplified settings laid over the chosen preset.
///
/// A field left empty keeps the preset's value: only what the user actually
/// touched is rewritten.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Simple {
    /// Layer height in millimeters.
    pub layer_height: Option<f32>,
    /// Infill in percent.
    pub infill: Option<f32>,
    /// Number of walls.
    pub walls: Option<u32>,
    pub supports: Option<bool>,
    pub brim: Option<bool>,
}

fn num(cfg: &Map<String, Value>, key: &str) -> Option<f32> {
    let v = cfg.get(key)?;
    match v {
        Value::String(s) => s.trim_end_matches('%').trim().parse().ok(),
        Value::Number(n) => n.as_f64().map(|x| x as f32),
        _ => None,
    }
}

fn flag(cfg: &Map<String, Value>, key: &str) -> Option<bool> {
    match cfg.get(key)? {
        Value::String(s) => Some(matches!(s.as_str(), "1" | "true")),
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

impl Simple {
    /// Values carried by the preset, to prefill the UI.
    pub fn from_config(cfg: &Map<String, Value>) -> Simple {
        Simple {
            layer_height: num(cfg, "layer_height"),
            infill: num(cfg, "sparse_infill_density"),
            walls: num(cfg, "wall_loops").map(|w| w as u32),
            supports: flag(cfg, "enable_support"),
            brim: cfg
                .get("brim_type")
                .and_then(|v| v.as_str())
                .map(|t| t != "no_brim"),
        }
    }

    /// Translation into configuration keys, in the format the engine expects:
    /// strings, with the percentage for infill.
    pub fn to_overrides(&self) -> Map<String, Value> {
        let mut m = Map::new();
        let mut put = |k: &str, v: String| {
            m.insert(k.into(), Value::String(v));
        };
        if let Some(h) = self.layer_height {
            put("layer_height", format!("{h}"));
        }
        if let Some(i) = self.infill {
            put("sparse_infill_density", format!("{}%", i.round() as i32));
        }
        if let Some(w) = self.walls {
            put("wall_loops", format!("{w}"));
        }
        if let Some(s) = self.supports {
            put("enable_support", if s { "1".into() } else { "0".into() });
        }
        if let Some(b) = self.brim {
            put("brim_type", if b { "outer_only".into() } else { "no_brim".into() });
        }
        m
    }
}

/// Starting values of a given preset.
pub fn defaults(machine: &str, process: &str) -> Result<Simple> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let idx = index_for(&app)?;
    let _ = machine;
    let cfg = idx
        .flatten(process)
        .ok_or_else(|| anyhow!(crate::t!("err.unknown_preset", name = process)))?;
    Ok(Simple::from_config(&cfg))
}

#[derive(Deserialize, Clone, Default)]
pub struct Request {
    pub source: String,
    pub machine: String,
    pub process: String,
    pub filaments: Vec<String>,
    /// Simplified settings; explicit overrides win.
    #[serde(default)]
    pub simple: Option<Simple>,
    #[serde(default)]
    pub overrides: Map<String, Value>,
    /// Destination folder; by default, next to the original file.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// Real spool color of each head (`#rrggbb`), if known.
    #[serde(default)]
    pub colors: Vec<Option<String>>,
    /// Head (0 to 3) printing each model extruder: entry `i` is about the file's
    /// extruder `i + 1`. Empty: single-color model.
    #[serde(default)]
    pub extruder_map: Vec<u8>,
    /// The Prepare view's plate: placed objects. When given, it replaces
    /// `source` (which may stay empty).
    #[serde(default)]
    pub scene: Vec<crate::plate::SceneItem>,
    /// Name given to a scene's result (G-code name).
    #[serde(default)]
    pub name: Option<String>,
}

/// Overhang angle of the print profile (`support_threshold_angle`), which
/// guides auto-orientation; 30° by default or if the profile says 0.
pub fn support_threshold(process: Option<&str>) -> f64 {
    let read = || -> Option<f64> {
        let app = engine()?;
        let idx = index_for(&app).ok()?;
        let p = process.map(String::from).or_else(|| idx.selected.get("print").cloned())?;
        let cfg = idx.flatten(&p)?;
        let v = cfg.get("support_threshold_angle")?;
        let s = match v {
            Value::Array(a) => a.first()?.as_str()?.to_string(),
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return None,
        };
        s.trim().parse::<f64>().ok()
    };
    match read() {
        Some(a) if a > 0.0 && a < 90.0 => a,
        _ => 30.0,
    }
}

/// A machine's bed: usable dimensions in millimeters and printer model, which
/// designates the plate and logo to draw.
#[derive(Serialize, Clone)]
pub struct Bed {
    pub w: f32,
    pub d: f32,
    pub model: Option<String>,
}

/// A machine's bed; the U1's by default.
pub fn bed(machine: Option<&str>) -> Bed {
    let u1 = Bed { w: 270.0, d: 270.0, model: Some("Snapmaker U1".into()) };
    let Some(app) = engine() else { return u1 };
    let Ok(idx) = index_for(&app) else { return u1 };
    let m = machine
        .map(String::from)
        .or_else(|| idx.selected.get("machine").cloned());
    match m {
        Some(m) => {
            let (w, d) = idx.plate_size(&m);
            Bed { w, d, model: idx.printer_model(&m) }
        }
        None => u1,
    }
}

#[derive(Serialize, Clone, Default)]
pub struct Progress {
    pub id: String,
    /// preparation | slicing | preview | error | cancelled
    pub phase: String,
    pub elapsed_s: f32,
    pub message: Option<String>,
    /// In the `preview` phase: temporary G-code, in the working folder.
    pub gcode: Option<String>,
    /// Progress announced by the engine, from 0 to 100.
    pub percent: Option<f32>,
    /// Slicing summary, in the `preview` phase.
    pub stats: Option<crate::gcode::SliceStats>,
}

/// Finished slice awaiting a decision: save, send, discard.
struct Preview {
    work: PathBuf,
    gcode: PathBuf,
    source: PathBuf,
    out_dir: Option<PathBuf>,
}

fn previews() -> &'static Mutex<std::collections::HashMap<String, Preview>> {
    static P: OnceLock<Mutex<std::collections::HashMap<String, Preview>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// Prefix of the working folders, in the system's temporary folder.
const WORK_PREFIX: &str = "snapstudio_slice_";

type Jobs = Mutex<std::collections::HashMap<String, u32>>;

fn jobs() -> &'static Jobs {
    static J: OnceLock<Jobs> = OnceLock::new();
    J.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn emit(app: &AppHandle, p: Progress) {
    let _ = app.emit("slice-progress", p);
}

/// Extracts the useful message from the engine's logs.
fn engine_error(out: &str) -> String {
    let lines: Vec<&str> = out
        .lines()
        .filter(|l| {
            let l = l.trim();
            !l.is_empty()
                && !l.contains("sentry")
                && !l.contains("StaticPrintConfigs")
                && !l.contains("Sentry session")
                && !l.contains("calc_exclude_triangles")
        })
        .collect();
    // "run found error, exit" ends every output and tells nothing: the useful
    // message is the line just before.
    let useful: Vec<&str> = lines
        .iter()
        .filter(|l| !l.contains("run found error"))
        .cloned()
        .collect();
    let pick = useful
        .iter()
        .rev()
        .find(|l| {
            l.contains("[error]")
                || l.contains("not compatible")
                || l.contains("not in range")
                || l.contains("Param values")
        })
        .or_else(|| useful.last())
        .or_else(|| lines.last())
        .copied();
    let silent = crate::t!("err.engine_silent");
    let raw = pick.unwrap_or(&silent).trim();
    // Remove the timestamp and thread, unreadable in the UI.
    match raw.rfind("]   ") {
        Some(i) => raw[i + 4..].trim().to_string(),
        None => raw.to_string(),
    }
}

/// Output name enriched with the material and duration, as Orca does.
fn output_name(source: &Path, gcode: &Path) -> String {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "piece".into());
    let mut bits = vec![stem];
    if let Ok(f) = std::fs::File::open(gcode) {
        if let Ok(d) = crate::gcode::parse(f) {
            if let Some(t) = d.meta.filaments.first() {
                bits.push(t.clone());
            }
            if let Some(s) = d.meta.print_time_s {
                let (h, m) = (s / 3600, (s % 3600) / 60);
                bits.push(if h > 0 { format!("{h}h{m:02}m") } else { format!("{m}m") });
            }
        }
    }
    format!("{}.gcode", bits.join("_"))
}

/// Beyond this, bundled slicing is no longer reasonable in memory.
const SLICE_TRI_BUDGET: usize = 8_000_000;

/// Rewrites a 3MF's geometry into a new file, centered on the bed and resting
/// at Z = 0.
///
/// `extruder_map[i]` gives the head (0 to 3) printing the model's extruder
/// `i + 1`. When the model declares its extruders, the geometry becomes a
/// single object with several parts, each assigned to its head; otherwise, a
/// single block left to the first head's filament.
fn rewrite_centered(source: &Path, work: &Path, plate: (f32, f32), extruder_map: &[u8]) -> Result<PathBuf> {
    let is_stl = source
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("stl"));
    let m = if is_stl {
        crate::stl::read(source)?
    } else {
        let mut zip = crate::model3mf::open(source)?;
        crate::mesh::load_mesh(&mut zip, SLICE_TRI_BUDGET)?
    };
    if m.truncated {
        return Err(anyhow!(crate::t!("err.model_too_dense", n = m.tris.len())));
    }
    let size = m.size();
    if size[0] > plate.0 || size[1] > plate.1 {
        return Err(anyhow!(crate::t!(
            "err.part_too_big",
            w = format!("{:.0}", size[0]),
            d = format!("{:.0}", size[1]),
            pw = format!("{:.0}", plate.0),
            pd = format!("{:.0}", plate.1)
        )));
    }
    let mut t = crate::mesh::Mat::IDENTITY;
    t.0[9] = (plate.0 - size[0]) / 2.0 - m.min[0];
    t.0[10] = (plate.1 - size[1]) / 2.0 - m.min[1];
    t.0[11] = -m.min[2];

    let name = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "piece".into());
    let dst = work.join(format!("{name}.3mf"));

    // Destination heads: one part per head, grouping the model extruders sent
    // to the same head.
    let head_of = |model_ext: u8| -> u8 {
        extruder_map
            .get(model_ext.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(0)
            .min(15)
    };
    let mut groups: std::collections::BTreeMap<u8, Vec<crate::mesh::Tri>> = Default::default();
    if m.extruders.len() == m.tris.len() {
        for (tri, e) in m.tris.iter().zip(&m.extruders) {
            groups.entry(head_of(*e)).or_default().push(*tri);
        }
    } else {
        groups.insert(head_of(1), m.tris);
    }
    let parts: Vec<crate::write3mf::Part> = groups
        .into_iter()
        .map(|(head, tris)| crate::write3mf::Part {
            name: format!("{name} — T{head}"),
            tris,
            extruder: head + 1,
        })
        .collect();
    crate::write3mf::write_multipart(&dst, &name, &parts, &t)?;
    Ok(dst)
}

/// Filaments declared by a model, to associate them with heads.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ModelInfo {
    /// One per model extruder (material, color), when the project declares them.
    pub filaments: Vec<crate::model3mf::ProjectFilament>,
    /// Extruders actually used by the model's objects (from 1).
    pub used: Vec<u8>,
}

pub fn model_info(source: &Path) -> Result<ModelInfo> {
    if crate::scan::kind_of(source) != Some("3mf") {
        return Ok(ModelInfo::default());
    }
    let mut zip = crate::model3mf::open(source)?;
    let filaments = crate::model3mf::project_filaments(&mut zip);
    let mut used: Vec<u8> = crate::model3mf::extruder_settings(&mut zip)
        .values()
        .flat_map(|(obj, parts)| {
            // The object's extruder only applies to itself if it has no parts, or to
            // its parts that do not declare one.
            let obj = (*obj).max(1);
            if parts.is_empty() {
                vec![obj]
            } else {
                parts.values().map(|e| if *e > 0 { *e } else { obj }).collect()
            }
        })
        .collect();
    used.sort_unstable();
    used.dedup();
    if used.is_empty() {
        used.push(1);
    }
    let filaments = if filaments.is_empty() { part_colors(&mut zip) } else { filaments };
    Ok(ModelInfo { filaments, used })
}

/// Colors of a model without project filaments — the AI tab's files, and
/// other plain 3MF: for each head, the color most of its triangles carry.
fn part_colors(zip: &mut crate::model3mf::Zip) -> Vec<crate::model3mf::ProjectFilament> {
    let Ok(m) = crate::mesh::load_mesh(zip, 200_000) else {
        return Vec::new();
    };
    let mut count: std::collections::BTreeMap<u8, std::collections::HashMap<[u8; 3], usize>> = Default::default();
    for (i, t) in m.tris.iter().enumerate() {
        if t.c == crate::render::DEFAULT_COLOR {
            continue;
        }
        let head = m.extruders.get(i).copied().unwrap_or(1).max(1);
        *count.entry(head).or_default().entry(t.c).or_default() += 1;
    }
    count
        .into_iter()
        .filter_map(|(head, colors)| {
            let (c, _) = colors.into_iter().max_by_key(|(_, n)| *n)?;
            Some(crate::model3mf::ProjectFilament {
                index: head,
                kind: String::new(),
                color: Some(format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])),
            })
        })
        .collect()
}

/// Starts a slice. Returns the job id.
pub fn start(app_handle: AppHandle, req: Request) -> Result<String> {
    let id = format!("{:x}", crate::util::fnv1a(&[
        req.source.as_bytes(),
        &std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .to_le_bytes(),
    ]));
    let engine_app = engine().ok_or_else(|| anyhow!(crate::engine::missing()))?;
    let bin = binary(&engine_app)?;
    let idx = index_for(&engine_app)?;
    let job_id = id.clone();

    std::thread::spawn(move || {
        let handle = app_handle.clone();
        run_job(bin, idx, req, job_id, &move |p| emit(&handle, p));
    });

    Ok(id)
}

/// Full run of a slice, independent of Tauri to stay testable.
pub fn run_job(
    bin: PathBuf,
    idx: Arc<Index>,
    req: Request,
    job_id: String,
    report: &(dyn Fn(Progress) + Send + Sync),
) {
    {
        let t0 = std::time::Instant::now();
        let el = |t: &std::time::Instant| t.elapsed().as_secs_f32();
        report(Progress {
            id: job_id.clone(),
            phase: "preparation".into(),
            elapsed_s: 0.0,
            message: None,
            gcode: None,
            ..Default::default()
        });

        let work = std::env::temp_dir().join(format!("{WORK_PREFIX}{job_id}"));
        let fail = |msg: String| {
            report(Progress {
                id: job_id.clone(),
                phase: "error".into(),
                elapsed_s: el(&t0),
                message: Some(msg),
                gcode: None,
                ..Default::default()
            });
            jobs().lock().unwrap().remove(&job_id);
        };
        let _ = std::fs::create_dir_all(&work);

        let mut overrides = req.simple.clone().unwrap_or_default().to_overrides();
        for (k, v) in &req.overrides {
            overrides.insert(k.clone(), v.clone());
        }
        let prep = match presets::prepare(
            &idx,
            &work,
            &req.machine,
            &req.process,
            &req.filaments,
            &req.colors,
            &overrides,
        ) {
            Ok(p) => p,
            Err(e) => return fail(e.to_string()),
        };

        // The engine crashes loading a 3MF with external geometry ("production"
        // extension), and on projects too. So the geometry is re-emitted into a
        // new file, as one block, resting at the center of the bed. It is also what
        // guarantees the part is printable where it is seen.
        // A scene has no source file: the result takes the plate's name, in the
        // folder of its first object.
        let scene_source = req.scene.first().map(|it| {
            let name = req.name.clone().unwrap_or_else(|| "plate".into());
            Path::new(&it.path).with_file_name(format!("{name}.3mf"))
        });
        let source = scene_source.as_deref().unwrap_or(Path::new(&req.source));
        let mut arrange = "0";
        let is_stl = source
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("stl"));
        let input = if !req.scene.is_empty() {
            let dst = work.join("plate.3mf");
            match crate::plate::write_scene(&req.scene, idx.plate_size(&req.machine), &dst) {
                Ok(_) => dst,
                Err(e) => return fail(e.to_string()),
            }
        } else if crate::scan::kind_of(source) == Some("3mf") || is_stl {
            match rewrite_centered(source, &work, idx.plate_size(&req.machine), &req.extruder_map) {
                Ok(p) => p,
                Err(e) => return fail(e.to_string()),
            }
        } else {
            // Other formats go as is: it is up to the engine to put them on the bed.
            arrange = "2";
            source.to_path_buf()
        };

        let out = work.join("out");
        let _ = std::fs::create_dir_all(&out);
        let settings = format!("{};{}", prep.machine.display(), prep.process.display());
        let fils = prep
            .filaments
            .iter()
            .map(|f| f.display().to_string())
            .collect::<Vec<_>>()
            .join(";");

        report(Progress {
            id: job_id.clone(),
            phase: "slicing".into(),
            elapsed_s: el(&t0),
            message: None,
            gcode: None,
            ..Default::default()
        });

        let mut cmd = std::process::Command::new(&bin);
        crate::util::no_window(&mut cmd);
        cmd.args(["--arrange", arrange, "--allow-newer-file", "--slice", "0"])
            .arg("--datadir").arg(engine_datadir())
            .arg("--load-settings").arg(&settings)
            .arg("--load-filaments").arg(&fils)
            .arg("--outputdir").arg(&out);
        // Real progress: the engine writes JSON lines into a named pipe. Without
        // a pipe (creation impossible, other system), the counter is enough.
        let pipe = progress_pipe(&work).and_then(|p| open_pipe(&p).map(|f| (p, f)));
        if let Some((p, _)) = &pipe {
            cmd.arg("--pipe").arg(p);
        }
        let child = cmd
            .arg(&input)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let child = match child {
            Ok(c) => c,
            Err(e) => return fail(crate::t!("err.engine_start", err = e)),
        };
        jobs().lock().unwrap().insert(job_id.clone(), child.id());

        // The pipe reader lives for the duration of the slice: a scoped thread can
        // therefore borrow `report`.
        let stop = std::sync::atomic::AtomicBool::new(false);
        let output = std::thread::scope(|sc| {
            if let Some((_, f)) = pipe {
                let (stop, id) = (&stop, job_id.clone());
                sc.spawn(move || {
                    progress_loop(f, stop, |percent, message| {
                        report(Progress {
                            id: id.clone(),
                            phase: "slicing".into(),
                            elapsed_s: t0.elapsed().as_secs_f32(),
                            message,
                            percent: Some(percent),
                            ..Default::default()
                        })
                    })
                });
            }
            let out = child.wait_with_output();
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            out
        });
        let output = match output {
            Ok(o) => o,
            Err(e) => return fail(e.to_string()),
        };
        let cancelled = !jobs().lock().unwrap().contains_key(&job_id);
        jobs().lock().unwrap().remove(&job_id);
        if cancelled {
            let _ = std::fs::remove_dir_all(&work);
            return report(Progress {
                id: job_id.clone(),
                phase: "cancelled".into(),
                elapsed_s: el(&t0),
                message: None,
                gcode: None,
                ..Default::default()
            });
        }

        let mut logs = String::from_utf8_lossy(&output.stdout).to_string();
        logs.push_str(&String::from_utf8_lossy(&output.stderr));
        if !output.status.success() {
            let mut msg = engine_error(&logs);
            if msg == crate::t!("err.engine_silent") {
                if let Some(code) = output.status.code() {
                    msg = format!("{msg} (code {code})");
                } else {
                    msg = crate::t!("err.engine_killed");
                }
            }
            return fail(msg);
        }

        let produced = std::fs::read_dir(&out)
            .ok()
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("gcode"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let Some(first) = produced.first() else {
            return fail(engine_error(&logs));
        };

        // The G-code stays in the working folder: it is a preview, which the user
        // will save, send to the printer or discard.
        let stats = std::fs::File::open(first)
            .ok()
            .and_then(|f| crate::gcode::parse(f).ok())
            .map(|d| crate::gcode::stats(&d));
        previews().lock().unwrap().insert(
            job_id.clone(),
            Preview {
                work: work.clone(),
                gcode: first.clone(),
                source: source.to_path_buf(),
                out_dir: req.out_dir.as_ref().map(PathBuf::from),
            },
        );

        report(Progress {
            id: job_id.clone(),
            phase: "preview".into(),
            elapsed_s: el(&t0),
            gcode: Some(first.to_string_lossy().to_string()),
            stats,
            ..Default::default()
        });
    }
}

/// Temporary G-code of a preview.
pub fn preview_gcode(id: &str) -> Option<PathBuf> {
    previews().lock().unwrap().get(id).map(|p| p.gcode.clone())
}

/// Saves the preview under a meaningful name, next to the model by default.
/// The preview stays available (for sending to the printer, for instance).
pub fn save(id: &str, dir: Option<&str>) -> Result<PathBuf> {
    // Paths taken under the lock, copy done outside it.
    let (gcode, dest) = {
        let list = previews().lock().unwrap();
        let p = list.get(id).ok_or_else(|| anyhow!(crate::t!("err.no_preview")))?;
        let dest_dir = dir
            .map(PathBuf::from)
            .or_else(|| p.out_dir.clone())
            .or_else(|| p.source.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir);
        (p.gcode.clone(), dest_dir.join(output_name(&p.source, &p.gcode)))
    };
    std::fs::copy(&gcode, &dest).map_err(|e| anyhow!(crate::t!("err.gcode_copy", err = e)))?;
    Ok(dest)
}

/// Original model of a preview.
pub fn preview_source(id: &str) -> Option<String> {
    previews().lock().unwrap().get(id).map(|p| p.source.to_string_lossy().to_string())
}

/// File name offered for a preview (saving, sending).
pub fn preview_name(id: &str) -> Option<String> {
    let list = previews().lock().unwrap();
    let p = list.get(id)?;
    Some(output_name(&p.source, &p.gcode))
}

/// Discards a preview: its working folder goes away.
pub fn discard(id: &str) {
    if let Some(p) = previews().lock().unwrap().remove(id) {
        let _ = std::fs::remove_dir_all(&p.work);
    }
}

/// Removes working folders left by a previous session (app quit with a
/// preview open, crash).
pub fn cleanup_stale() {
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let day = std::time::Duration::from_secs(24 * 3600);
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().starts_with(WORK_PREFIX) {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > day);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Creates the named pipe through which the engine announces its progress.
#[cfg(unix)]
fn progress_pipe(work: &Path) -> Option<PathBuf> {
    let p = work.join("progress.pipe");
    let _ = std::fs::remove_file(&p);
    let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).ok()?;
    // SAFETY: valid C path, NUL-terminated, for the duration of the call.
    let r = unsafe { libc::mkfifo(c.as_ptr(), 0o600) };
    (r == 0).then_some(p)
}

#[cfg(not(unix))]
fn progress_pipe(_work: &Path) -> Option<PathBuf> {
    None
}

/// Opens the pipe for reading, before the launch: the engine opens it for
/// non-blocking writing, which fails as long as there is no reader.
#[cfg(unix)]
fn open_pipe(pipe: &Path) -> Option<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(pipe)
        .ok()
}

#[cfg(not(unix))]
fn open_pipe(_pipe: &Path) -> Option<std::fs::File> {
    None
}

/// Reads the engine's `{"total_percent": …, "message": …}` JSON lines until
/// `stop` turns true.
fn progress_loop(mut f: std::fs::File, stop: &std::sync::atomic::AtomicBool, on: impl Fn(f32, Option<String>)) {
    use std::io::Read;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let pause = std::time::Duration::from_millis(100);
    loop {
        let done = stop.load(std::sync::atomic::Ordering::Relaxed);
        match f.read(&mut chunk) {
            Ok(n) if n > 0 => {
                buf.extend_from_slice(&chunk[..n]);
                while let Some(i) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=i).collect();
                    if let Some((pct, msg)) = parse_progress(&String::from_utf8_lossy(&line)) {
                        on(pct, msg);
                    }
                }
            }
            // Nothing to read: no writer yet, or empty pipe.
            _ if done => break,
            _ => std::thread::sleep(pause),
        }
    }
}

/// A line from the engine: overall progress and optional message.
fn parse_progress(line: &str) -> Option<(f32, Option<String>)> {
    let v: Value = serde_json::from_str(line.trim_matches(|c: char| c == '\0' || c.is_whitespace())).ok()?;
    let pct = v.get("total_percent").and_then(|x| x.as_f64())? as f32;
    let msg = v
        .get("message")
        .or_else(|| v.get("warning"))
        .and_then(|x| x.as_str())
        .filter(|m| !m.is_empty())
        .map(String::from);
    Some((pct.clamp(0.0, 100.0), msg))
}


#[cfg(unix)]
fn terminate(pid: u32) {
    // SAFETY: plain signal sent to a process we started.
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
}

#[cfg(windows)]
fn terminate(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    crate::util::no_window(&mut cmd);
    let _ = cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).status();
}

/// Interrupts a running slice.
pub fn cancel(id: &str) -> bool {
    let pid = jobs().lock().unwrap().remove(id);
    match pid {
        Some(pid) => {
            // The engine has nothing to save, the working folder is cleaned up by
            // the thread waiting for it.
            terminate(pid);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_is_found() {
        let Some(app) = engine() else { return };
        let bin = binary(&app).unwrap();
        println!("engine: {}", bin.display());
        assert!(bin.is_file());
    }

    #[test]
    fn lists_are_filtered() {
        let Ok(l) = lists(None) else { return };
        println!(
            "{} machines, {} processes, {} filaments, {} heads",
            l.machines.len(),
            l.processes.len(),
            l.filaments.len(),
            l.extruders
        );
        assert!(!l.machines.is_empty());
        assert!(!l.processes.is_empty(), "processes compatible with the chosen machine");
    }

    /// Full run: preparation, slicing, file put in the right place.
    #[test]
    fn full_job_produces_gcode() {
        let (Some(app), Ok(model)) = (engine(), std::env::var("SLICE_MODEL")) else {
            return;
        };
        let idx = index_for(&app).unwrap();
        let l = lists(None).unwrap();
        let machine = l
            .selected
            .get("machine")
            .cloned()
            .unwrap_or_else(|| l.machines[0].name.clone());
        let process = l.processes[0].name.clone();
        let filament = l
            .filaments
            .iter()
            .find(|f| f.name.contains("PLA"))
            .unwrap_or(&l.filaments[0])
            .name
            .clone();

        let out_dir = std::env::temp_dir().join("snapstudio_job_out");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();

        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            idx,
            Request {
                source: model,
                machine: machine.clone(),
                process: process.clone(),
                filaments: vec![filament.clone()],
                simple: None,
                overrides: Map::new(),
                out_dir: Some(out_dir.to_string_lossy().to_string()),
                ..Default::default()
            },
            "test".into(),
            &move |p| sink.lock().unwrap().push(p),
        );

        let got = seen.lock().unwrap();
        let phases: Vec<&str> = got.iter().map(|p| p.phase.as_str()).collect();
        println!("phases: {phases:?}");
        if let Some(last) = got.last() {
            println!(
                "last: {} in {:.1} s, message {:?}, file {:?}",
                last.phase, last.elapsed_s, last.message, last.gcode
            );
        }
        assert_eq!(phases.first(), Some(&"preparation"));
        assert!(phases.contains(&"slicing"));
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let stats = last.stats.clone().expect("summary attached to the preview");
        println!("bilan : {stats:?}");
        assert!(stats.print_time_s.unwrap_or(0) > 0, "estimated time");
        let tmp = PathBuf::from(last.gcode.clone().unwrap());
        assert!(tmp.is_file(), "preview in the working folder");
        let g = save("test", None).unwrap();
        assert!(g.is_file(), "the G-code is put down");
        assert!(g.starts_with(&out_dir), "in the requested folder");
        assert!(std::fs::metadata(&g).unwrap().len() > 10_000);
        println!("→ {}", g.file_name().unwrap().to_string_lossy());
    }

    #[test]
    fn simple_reads_and_writes_preset_values() {
        let Ok(l) = lists(None) else { return };
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let process = l
            .processes
            .iter()
            .find(|p| p.name.contains("0.20"))
            .unwrap_or(&l.processes[0])
            .name
            .clone();
        let d = defaults(&machine, &process).unwrap();
        println!("“{process}” → {d:?}");
        assert!(d.layer_height.unwrap_or(0.0) > 0.0);
        assert!(d.infill.unwrap_or(-1.0) >= 0.0, "infill read");
        assert!(d.walls.unwrap_or(0) >= 1, "walls read");

        // Nothing touched, nothing rewritten.
        assert!(Simple::default().to_overrides().is_empty());

        let s = Simple {
            layer_height: Some(0.28),
            infill: Some(25.0),
            walls: Some(3),
            supports: Some(true),
            brim: Some(false),
        };
        let o = s.to_overrides();
        assert_eq!(o["layer_height"], "0.28");
        assert_eq!(o["sparse_infill_density"], "25%", "the engine expects a percentage");
        assert_eq!(o["wall_loops"], "3");
        assert_eq!(o["enable_support"], "1");
        assert_eq!(o["brim_type"], "no_brim");
    }

    /// A forced layer height must end up in the G-code produced.
    #[test]
    fn override_reaches_the_gcode() {
        let (Some(app), Ok(model)) = (engine(), std::env::var("SLICE_MODEL")) else {
            return;
        };
        let l = lists(None).unwrap();
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let process = l.processes[0].name.clone();
        let filament = l
            .filaments
            .iter()
            .find(|f| f.name.contains("PLA"))
            .unwrap_or(&l.filaments[0])
            .name
            .clone();
        let out_dir = std::env::temp_dir().join("snapstudio_job_ovr");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();

        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                source: model,
                machine,
                process,
                filaments: vec![filament],
                simple: Some(Simple { layer_height: Some(0.3), infill: Some(5.0), ..Default::default() }),
                overrides: Map::new(),
                out_dir: Some(out_dir.to_string_lossy().to_string()),
                ..Default::default()
            },
            "ovr".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let g = PathBuf::from(last.gcode.clone().unwrap());
        let d = crate::gcode::parse(std::fs::File::open(&g).unwrap()).unwrap();
        println!(
            "layer asked 0.30 mm → {:?} announced, {} layers, {:.1} s",
            d.meta.layer_height,
            d.layers + 1,
            last.elapsed_s
        );
        assert_eq!(d.meta.layer_height, Some(0.3), "the forced layer height is applied");
    }

    /// A project with external geometry — the "production" extension — used to
    /// crash the engine without any message. The geometry is now re-emitted as
    /// one block before being sliced.
    #[test]
    fn production_extension_project_slices() {
        let (Some(app), Ok(model)) = (engine(), std::env::var("PROJECT_MODEL")) else {
            return;
        };
        // The file must really be of the type that caused the problem.
        let z = crate::model3mf::open(Path::new(&model)).unwrap();
        let names = crate::model3mf::entry_names(&z);
        assert!(
            names.iter().any(|n| n.starts_with("3D/Objects/")),
            "this test targets a 3MF with external geometry"
        );
        drop(z);

        let l = lists(None).unwrap();
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let out_dir = std::env::temp_dir().join("snapstudio_job_prod");
        let _ = std::fs::remove_dir_all(&out_dir);
        std::fs::create_dir_all(&out_dir).unwrap();
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                source: model,
                machine,
                process: l.processes[0].name.clone(),
                filaments: vec![l.filaments[0].name.clone()],
                simple: None,
                overrides: Map::new(),
                out_dir: Some(out_dir.to_string_lossy().to_string()),
                ..Default::default()
            },
            "prod".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        println!("→ {}", last.gcode.clone().unwrap());
    }

    #[test]
    fn engine_progress_lines_are_read() {
        let (pct, msg) = parse_progress(r#"{"plate_index":1,"plate_count":1,"plate_percent":40,"total_percent":37,"message":"Generating G-code"}"#).unwrap();
        assert_eq!(pct, 37.0);
        assert_eq!(msg.as_deref(), Some("Generating G-code"));
        assert!(parse_progress("bruit").is_none());
        let (_, none) = parse_progress("{\"total_percent\":100,\"message\":\"\"}\0\0").unwrap();
        assert!(none.is_none(), "empty message ignored, NUL bytes tolerated");
    }

    /// Extruders used: the parts', the object's for parts that declare none;
    /// project filaments read with their color.
    #[test]
    fn model_info_counts_part_extruders() {
        use std::io::Write;
        let tmp = std::env::temp_dir().join("snapstudio-model-info.3mf");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&tmp).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("Metadata/model_settings.config", o).unwrap();
        z.write_all(br#"<config>
  <object id="7"><metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part"><metadata key="extruder" value="2"/></part>
    <part id="2" subtype="normal_part"><metadata key="extruder" value="3"/></part>
    <part id="3" subtype="normal_part"/>
  </object>
  <object id="9"><metadata key="extruder" value="4"/></object>
</config>"#).unwrap();
        z.start_file("Metadata/project_settings.config", o).unwrap();
        z.write_all(br##"{"filament_type":["PLA","PETG"],"filament_colour":["#FF0000FF","#00FF00"]}"##).unwrap();
        z.finish().unwrap();
        let info = model_info(&tmp).unwrap();
        // Part 3 without an extruder: the object's (1); object 9, without parts, 4.
        assert_eq!(info.used, vec![1, 2, 3, 4]);
        assert_eq!(info.filaments.len(), 2);
        assert_eq!(info.filaments[0].color.as_deref(), Some("#ff0000"));
        assert_eq!(info.filaments[1].kind, "PETG");
        let _ = std::fs::remove_file(&tmp);
    }

    /// A two-extruder model becomes an object with two parts, each on the
    /// requested head.
    #[test]
    fn multicolor_model_keeps_its_heads() {
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-multicolor-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let tri = |z: f32| Tri { v: [[0., 0., z], [10., 0., z], [0., 10., z + 1.]], c: [200, 30, 30] };
        let src = tmp.join("two.3mf");
        crate::write3mf::write_multipart(
            &src,
            "two",
            &[
                crate::write3mf::Part { name: "bas".into(), tris: vec![tri(0.)], extruder: 1 },
                crate::write3mf::Part { name: "haut".into(), tris: vec![tri(20.)], extruder: 2 },
            ],
            &Mat::IDENTITY,
        )
        .unwrap();
        let info = model_info(&src).unwrap();
        assert_eq!(info.used, vec![1, 2]);

        // Extruder 1 → head 3, extruder 2 → head 0.
        let out = rewrite_centered(&src, &tmp, (270.0, 270.0), &[3, 0]).unwrap();
        let mut zip = crate::model3mf::open(&out).unwrap();
        let m = crate::mesh::load_mesh(&mut zip, 1_000).unwrap();
        assert_eq!(m.extruders.len(), m.tris.len());
        let low = m.tris.iter().position(|t| t.v[0][2] < 1.0).unwrap();
        let high = m.tris.iter().position(|t| t.v[0][2] > 10.0).unwrap();
        assert_eq!(m.extruders[low], 4, "bottom on head 3");
        assert_eq!(m.extruders[high], 1, "top on head 0");
        assert!(m.tris[high].v[0][2] > 15.0, "the high part stays up");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Real slice of a two-color model (machine with the engine installed).
    #[test]
    fn multicolor_job_uses_two_heads() {
        let Some(app) = engine() else { return };
        let Ok(l) = lists(None) else { return };
        if l.extruders < 2 {
            return;
        }
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-multicolor-slice");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // Two stacked 10 mm cubes.
        let cube = |z0: f32| -> Vec<Tri> {
            let s = 10.0;
            let p = [
                [0., 0., z0], [s, 0., z0], [s, s, z0], [0., s, z0],
                [0., 0., z0 + s], [s, 0., z0 + s], [s, s, z0 + s], [0., s, z0 + s],
            ];
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let src = tmp.join("bicolore.3mf");
        crate::write3mf::write_multipart(
            &src,
            "bicolore",
            &[
                crate::write3mf::Part { name: "bas".into(), tris: cube(0.0), extruder: 1 },
                crate::write3mf::Part { name: "haut".into(), tris: cube(10.0), extruder: 2 },
            ],
            &Mat::IDENTITY,
        )
        .unwrap();
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let fil = l.filaments.iter().find(|f| f.name.contains("PLA")).unwrap_or(&l.filaments[0]).name.clone();
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                source: src.to_string_lossy().to_string(),
                machine,
                process: l.processes[0].name.clone(),
                filaments: vec![fil.clone(), fil.clone(), fil.clone(), fil],
                extruder_map: vec![0, 1],
                ..Default::default()
            },
            "bicolore".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let tools = last.stats.clone().unwrap().tools;
        println!("heads used: {tools:?}");
        assert!(tools.contains(&0) && tools.contains(&1), "both heads extrude");
        discard("bicolore");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Real slice of a plate scene: two placed objects, one rotated; the G-code
    /// must find them where the plate put them.
    /// Smoke test of an engine: real U1 0.4 mm profiles, two cubes on two heads.
    /// Run by the "Engine" CI on each slimmed engine:
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_smoke -- --ignored`.
    #[test]
    #[ignore]
    fn engine_smoke() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        println!("engine: {}", app.display());
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles readable in the engine");
        assert!(l.machines.iter().any(|m| m.name == machine), "U1 0.4 machine profile");
        let process = l
            .processes
            .iter()
            .find(|p| p.name.starts_with("0.20mm Standard"))
            .unwrap_or(&l.processes[0])
            .name
            .clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("un filament PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-smoke");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cube = |s: f32| -> Vec<Tri> {
            let p = [[0., 0., 0.], [s, 0., 0.], [s, s, 0.], [0., s, 0.], [0., 0., s], [s, 0., s], [s, s, s], [0., s, s]];
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let src = tmp.join("cubes.3mf");
        crate::write3mf::write_scene(&src, &[
            crate::write3mf::SceneObject { name: "a".into(), tris: cube(12.0), transform: Mat::IDENTITY, extruder: None },
            crate::write3mf::SceneObject { name: "b".into(), tris: cube(12.0), transform: Mat::IDENTITY, extruder: None },
        ]).unwrap();
        // One cube per head: T0 and T1.
        let item = |i: usize, x: f32, head: u8| crate::plate::SceneItem {
            path: src.to_string_lossy().to_string(),
            item: i,
            name: format!("cube {i}"),
            pos: [x, 100.0],
            rot: [0.0, 0.0, 0.0],
            scale: [1.0, 1.0, 1.0],
            extruder_map: vec![head],
        };
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        let t0 = std::time::Instant::now();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process,
                filaments: vec![pla.clone(), pla],
                scene: vec![item(0, 100.0, 0), item(1, 170.0, 1)],
                name: Some("smoke".into()),
                ..Default::default()
            },
            "smoke".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
        let path = last.gcode.clone().unwrap();
        let stats = last.stats.clone().expect("bilan");
        println!("G-code in {:.1} s: {} · {:?} · heads {:?}", t0.elapsed().as_secs_f32(), path, stats.print_time_s, stats.tools);
        assert!(std::fs::metadata(&path).unwrap().len() > 10_000, "non-empty G-code");
        assert!(stats.tools.contains(&0) && stats.tools.contains(&1), "both heads are used");
        discard("smoke");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Advanced settings reach the engine: a real slice with the overrides the
    /// slice sheet's sub-panels send, read back from the G-code's config block.
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_advanced_overrides -- --ignored`.
    #[test]
    #[ignore]
    fn engine_advanced_overrides() {
        let app = engine().expect("SNAPSTUDIO_ENGINE: engine to try out");
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profiles");
        let process = l.processes.iter().find(|p| p.name.starts_with("0.20mm Standard")).unwrap_or(&l.processes[0]).name.clone();
        let pla = l.filaments.iter().find(|f| f.name.contains("PLA")).expect("PLA").name.clone();
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-engine-adv");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // An overhanging "T": supports have something to do.
        let bx = |x0: f32, y0: f32, z0: f32, x1: f32, y1: f32, z1: f32| -> Vec<Tri> {
            let p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let mut t = bx(8.0, 8.0, 0.0, 12.0, 12.0, 10.0);
        t.extend(bx(0.0, 0.0, 10.0, 20.0, 20.0, 13.0));
        let src = tmp.join("t.3mf");
        crate::write3mf::write_scene(&src, &[
            crate::write3mf::SceneObject { name: "t".into(), tris: t, transform: Mat::IDENTITY, extruder: None },
        ]).unwrap();
        let mut overrides = Map::new();
        for (k, v) in [
            ("seam_position", "back"), ("seam_gap", "12%"), ("staggered_inner_seams", "1"),
            ("support_type", "tree(auto)"), ("support_style", "tree_slim"), ("support_interface_top_layers", "3"),
            ("support_threshold_angle", "40"), ("tree_support_branch_angle", "35"),
            ("brim_type", "brim_ears"), ("brim_width", "7"), ("brim_object_gap", "0.2"),
            ("enable_prime_tower", "1"), ("prime_tower_width", "40"), ("flush_into_infill", "1"),
            ("wall_filament", "2"), ("support_filament", "2"),
        ] {
            overrides.insert(k.into(), Value::String(v.into()));
        }
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process,
                filaments: vec![pla.clone(), pla],
                scene: vec![crate::plate::SceneItem {
                    path: src.to_string_lossy().to_string(), item: 0, name: "t".into(),
                    pos: [120.0, 120.0], rot: [0.0; 3], scale: [1.0; 3], extruder_map: vec![0],
                }],
                simple: Some(Simple { supports: Some(true), brim: Some(true), ..Default::default() }),
                overrides,
                name: Some("adv".into()),
                ..Default::default()
            },
            "adv".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "slicing failed: {:?}", last.message);
        let gcode = std::fs::read_to_string(last.gcode.clone().unwrap()).unwrap();
        for (k, v) in [
            ("seam_position", "back"), ("seam_gap", "12%"), ("enable_support", "1"), ("support_type", "tree(auto)"),
            ("support_style", "tree_slim"), ("support_interface_top_layers", "3"), ("brim_type", "brim_ears"),
            ("brim_width", "7"), ("enable_prime_tower", "1"), ("prime_tower_width", "40"), ("wall_filament", "2"),
            ("support_filament", "2"),
        ] {
            let line = format!("; {k} = {v}");
            assert!(gcode.contains(&line), "missing in G-code: {line}");
        }
        let stats = last.stats.clone().unwrap();
        println!("heads used: {:?}", stats.tools);
        assert!(stats.tools.contains(&1), "wall/support filament 2 extrudes on T1");
        discard("adv");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn plate_scene_job_keeps_placements() {
        let Some(app) = engine() else { return };
        let Ok(l) = lists(None) else { return };
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-scene-slice");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cube = |s: f32| -> Vec<Tri> {
            let p = [[0., 0., 0.], [s, 0., 0.], [s, s, 0.], [0., s, 0.], [0., 0., s], [s, 0., s], [s, s, s], [0., s, s]];
            let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                     [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
            f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [120, 120, 120] }).collect()
        };
        let src = tmp.join("cubes.3mf");
        crate::write3mf::write_scene(&src, &[
            crate::write3mf::SceneObject { name: "a".into(), tris: cube(15.0), transform: Mat::IDENTITY, extruder: None },
            crate::write3mf::SceneObject { name: "b".into(), tris: cube(15.0), transform: Mat::IDENTITY, extruder: None },
        ]).unwrap();
        let item = |i: usize, x: f32, rz: f32| crate::plate::SceneItem {
            path: src.to_string_lossy().to_string(),
            item: i,
            name: format!("cube {i}"),
            pos: [x, 60.0],
            rot: [0.0, 0.0, rz],
            scale: [1.0, 1.0, 1.0],
            extruder_map: vec![0],
        };
        let machine = l.selected.get("machine").cloned().unwrap_or_else(|| l.machines[0].name.clone());
        let fil = l.filaments.iter().find(|f| f.name.contains("PLA")).unwrap_or(&l.filaments[0]).name.clone();
        let seen: Arc<Mutex<Vec<Progress>>> = Default::default();
        let sink = seen.clone();
        run_job(
            binary(&app).unwrap(),
            index_for(&app).unwrap(),
            Request {
                machine,
                process: l.processes[0].name.clone(),
                filaments: vec![fil],
                scene: vec![item(0, 60.0, 0.0), item(1, 180.0, 30.0)],
                name: Some("scene".into()),
                ..Default::default()
            },
            "scene".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let g = crate::gcode::parse(std::fs::File::open(last.gcode.clone().unwrap()).unwrap()).unwrap();
        println!("G-code extent: {:?} → {:?}", g.min, g.max);
        assert!(g.min[0] > 40.0 && g.max[0] < 200.0, "the cubes stay around X = 60 and X = 180");
        discard("scene");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn error_message_is_readable() {
        let raw = "Starting Sentry session and setting flags...\n\
                   [2026-09-19 10:26:01.463331] [0x00000001f60b6180] [error]   run 2334: process not compatible with printer.\n\
                   run found error, exit";
        assert_eq!(engine_error(raw), "run 2334: process not compatible with printer.");
    }

    #[test]
    fn output_name_uses_gcode_metadata() {
        let Ok(g) = std::env::var("NAME_GCODE") else { return };
        let n = output_name(Path::new("/tmp/Ma piece.3mf"), Path::new(&g));
        println!("output name: {n}");
        assert!(n.starts_with("Ma piece"));
        assert!(n.ends_with(".gcode"));
    }
}
