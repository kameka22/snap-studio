//! Découpe en tâche de fond par le moteur de Snapmaker Orca.
//!
//! Le moteur est lancé sans interface : il reçoit des configurations complètes
//! écrites par [`crate::presets`], un fichier de géométrie, et rend un G-code.
//! Rien n'apparaît à l'écran, l'application reste maîtresse du déroulé.
//!
//! Deux drapeaux sont indispensables et faciles à oublier :
//! `--arrange 0`, sans quoi le moteur réarrange le plateau et ignore le
//! placement demandé, et `--allow-newer-file`, sans quoi il refuse les projets
//! enregistrés par une version plus récente que la sienne.

use crate::presets::{self, Index};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Inventaire des préréglages, relu seulement quand l'application change.
fn index_for(app: &Path) -> Result<Arc<Index>> {
    static CACHE: OnceLock<Mutex<Option<(PathBuf, Arc<Index>)>>> = OnceLock::new();
    let cell = CACHE.get_or_init(|| Mutex::new(None));
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

/// Moteur de découpe : celui que Snap Studio a téléchargé (`engine.rs`).
///
/// `SNAPSTUDIO_ENGINE` désigne un moteur précis (`.app`, exécutable ou
/// `AppRun`) : c'est ainsi que la CI éprouve un moteur allégé. Tant
/// qu'aucun moteur n'est référencé (version de développement), Snapmaker
/// Orca installé sert de repli.
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

/// Dossier de données du moteur (journaux, cache) : celui de Snap Studio, pour
/// ne jamais écrire dans celui de Snapmaker Orca ni en créer un.
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
    /// Préréglages sélectionnés dans Snapmaker Orca.
    pub selected: std::collections::HashMap<String, String>,
    pub extruders: usize,
    pub engine: Option<String>,
    /// Plateaux de la machine et celui par défaut.
    pub bed_types: Vec<presets::BedType>,
    pub bed_type: String,
}

/// Contenu effectif d'un préréglage pour la fenêtre de détail : ce que le
/// moteur recevra, réglages rapides, plateau et couleur de bobine compris.
pub fn details(
    name: &str,
    machine: &str,
    simple: Option<Simple>,
    overrides: &Map<String, Value>,
    color: Option<&str>,
) -> Result<presets::Details> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::MISSING))?;
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
    idx.details(name, &extra).ok_or_else(|| anyhow!("préréglage inconnu : {name}"))
}

/// Listes proposables, filtrées pour la machine demandée.
pub fn lists(machine: Option<&str>) -> Result<PresetLists> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::MISSING))?;
    let idx = index_for(&app)?;
    let machines = idx.machines();
    let chosen = machine
        .map(String::from)
        .or_else(|| idx.selected.get("machine").cloned())
        .filter(|m| machines.iter().any(|x| &x.name == m))
        .or_else(|| machines.first().map(|m| m.name.clone()))
        .ok_or_else(|| anyhow!("aucune machine disponible"))?;
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

/// Réglages simplifiés posés par-dessus le préréglage choisi.
///
/// Un champ laissé vide garde la valeur du préréglage : on ne réécrit que ce
/// que l'utilisateur a effectivement touché.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Simple {
    /// Hauteur de couche en millimètres.
    pub layer_height: Option<f32>,
    /// Remplissage en pourcentage.
    pub infill: Option<f32>,
    /// Nombre de parois.
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
    /// Valeurs portées par le préréglage, pour préremplir l'interface.
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

    /// Traduction en clés de configuration, au format attendu par le moteur :
    /// des chaînes, avec le pourcentage pour le remplissage.
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

/// Valeurs de départ d'un préréglage donné.
pub fn defaults(machine: &str, process: &str) -> Result<Simple> {
    let app = engine().ok_or_else(|| anyhow!(crate::engine::MISSING))?;
    let idx = index_for(&app)?;
    let _ = machine;
    let cfg = idx
        .flatten(process)
        .ok_or_else(|| anyhow!("préréglage inconnu : {process}"))?;
    Ok(Simple::from_config(&cfg))
}

#[derive(Deserialize, Clone, Default)]
pub struct Request {
    pub source: String,
    pub machine: String,
    pub process: String,
    pub filaments: Vec<String>,
    /// Réglages simplifiés ; les surcharges explicites l'emportent.
    #[serde(default)]
    pub simple: Option<Simple>,
    #[serde(default)]
    pub overrides: Map<String, Value>,
    /// Dossier de destination ; par défaut, à côté du fichier d'origine.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// Couleur réelle de la bobine de chaque tête (`#rrggbb`), si connue.
    #[serde(default)]
    pub colors: Vec<Option<String>>,
    /// Tête (0 à 3) imprimant chaque extrudeur du modèle : l'entrée `i`
    /// concerne l'extrudeur `i + 1` du fichier. Vide : modèle monocolore.
    #[serde(default)]
    pub extruder_map: Vec<u8>,
    /// Plateau de la vue Préparer : objets placés. Quand il est fourni, il
    /// remplace `source` (qui peut rester vide).
    #[serde(default)]
    pub scene: Vec<crate::plate::SceneItem>,
    /// Nom donné au résultat d'une scène (nom du G-code).
    #[serde(default)]
    pub name: Option<String>,
}

/// Angle de surplomb du profil d'impression (`support_threshold_angle`), qui
/// guide l'orientation automatique ; 30° à défaut ou si le profil vaut 0.
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

/// Plateau d'une machine : dimensions utiles en millimètres et modèle
/// d'imprimante, qui désigne la plaque et le logo à dessiner.
#[derive(Serialize, Clone)]
pub struct Bed {
    pub w: f32,
    pub d: f32,
    pub model: Option<String>,
}

/// Plateau d'une machine ; celui de la U1 à défaut.
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
    /// En phase `preview` : G-code provisoire, dans le dossier de travail.
    pub gcode: Option<String>,
    /// Avancement annoncé par le moteur, de 0 à 100.
    pub percent: Option<f32>,
    /// Bilan de la découpe, en phase `preview`.
    pub stats: Option<crate::gcode::SliceStats>,
}

/// Découpe terminée en attente d'une décision : enregistrer, envoyer, jeter.
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

/// Préfixe des dossiers de travail, dans le dossier temporaire du système.
const WORK_PREFIX: &str = "snapstudio_slice_";

type Jobs = Mutex<std::collections::HashMap<String, u32>>;

fn jobs() -> &'static Jobs {
    static J: OnceLock<Jobs> = OnceLock::new();
    J.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn emit(app: &AppHandle, p: Progress) {
    let _ = app.emit("slice-progress", p);
}

/// Extrait le message utile des journaux du moteur.
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
    // « run found error, exit » clôt toutes les sorties et n'apprend rien :
    // le message utile est la ligne juste avant.
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
    let raw = pick.unwrap_or("le moteur s'est arrêté sans message").trim();
    // On retire l'horodatage et le fil d'exécution, illisibles dans l'interface.
    match raw.rfind("]   ") {
        Some(i) => raw[i + 4..].trim().to_string(),
        None => raw.to_string(),
    }
}

/// Nom de sortie enrichi avec la matière et la durée, comme le fait Orca.
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

/// Au-delà, la découpe intégrée n'est plus raisonnable en mémoire.
const SLICE_TRI_BUDGET: usize = 8_000_000;

/// Réécrit la géométrie d'un 3MF dans un fichier neuf, centrée sur le plateau
/// et posée à Z = 0.
///
/// `extruder_map[i]` donne la tête (0 à 3) qui imprime l'extrudeur `i + 1` du
/// modèle. Quand le modèle déclare ses extrudeurs, la géométrie devient un
/// objet unique à plusieurs pièces, chacune affectée à sa tête ; sinon, un
/// bloc unique laissé au filament de la première tête.
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
        return Err(anyhow!(
            "modèle trop dense pour la découpe intégrée ({} triangles)",
            m.tris.len()
        ));
    }
    let size = m.size();
    if size[0] > plate.0 || size[1] > plate.1 {
        return Err(anyhow!(
            "la pièce dépasse le plateau : {:.0} × {:.0} mm pour un plateau de {:.0} × {:.0} mm",
            size[0], size[1], plate.0, plate.1
        ));
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

    // Têtes de destination : une pièce par tête, en regroupant les extrudeurs
    // du modèle envoyés sur la même tête.
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

/// Filaments déclarés par un modèle, pour les associer aux têtes.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ModelInfo {
    /// Un par extrudeur du modèle (matière, couleur), quand le projet les déclare.
    pub filaments: Vec<crate::model3mf::ProjectFilament>,
    /// Extrudeurs réellement employés par les objets du modèle (à partir de 1).
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
            // L'extrudeur de l'objet ne vaut que pour lui-même s'il n'a pas de
            // pièces, ou pour ses pièces qui n'en déclarent pas.
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
    Ok(ModelInfo { filaments, used })
}

/// Lance une découpe. Renvoie l'identifiant du travail.
pub fn start(app_handle: AppHandle, req: Request) -> Result<String> {
    let id = format!("{:x}", crate::util::fnv1a(&[
        req.source.as_bytes(),
        &std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            .to_le_bytes(),
    ]));
    let engine_app = engine().ok_or_else(|| anyhow!(crate::engine::MISSING))?;
    let bin = binary(&engine_app)?;
    let idx = index_for(&engine_app)?;
    let job_id = id.clone();

    std::thread::spawn(move || {
        let handle = app_handle.clone();
        run_job(bin, idx, req, job_id, &move |p| emit(&handle, p));
    });

    Ok(id)
}

/// Déroulé complet d'une découpe, indépendant de Tauri pour rester testable.
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

        // Le moteur plante en chargeant un 3MF à géométrie externe (extension
        // « production »), et aussi sur les projets. On réémet donc la
        // géométrie dans un fichier neuf, en un seul bloc, posé au centre du
        // plateau. C'est aussi ce qui garantit que la pièce est imprimable là
        // où on la voit.
        // Une scène n'a pas de fichier source : le résultat prend le nom du
        // plateau, dans le dossier de son premier objet.
        let scene_source = req.scene.first().map(|it| {
            let name = req.name.clone().unwrap_or_else(|| "plateau".into());
            Path::new(&it.path).with_file_name(format!("{name}.3mf"))
        });
        let source = scene_source.as_deref().unwrap_or(Path::new(&req.source));
        let mut arrange = "0";
        let is_stl = source
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("stl"));
        let input = if !req.scene.is_empty() {
            let dst = work.join("plateau.3mf");
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
            // Les autres formats partent tels quels : c'est au moteur de les
            // poser sur le plateau.
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
        // Avancement réel : le moteur écrit des lignes JSON dans un tube nommé.
        // Sans tube (création impossible, autre système), le compteur suffit.
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
            Err(e) => return fail(format!("moteur non lançable : {e}")),
        };
        jobs().lock().unwrap().insert(job_id.clone(), child.id());

        // Le lecteur du tube vit le temps de la découpe : un fil à portée
        // limitée peut donc emprunter `report`.
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
            if msg.starts_with("le moteur s'est arrêté") {
                if let Some(code) = output.status.code() {
                    msg = format!("{msg} (code {code})");
                } else {
                    msg = "le moteur s'est interrompu brutalement".into();
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

        // Le G-code reste dans le dossier de travail : c'est un aperçu, que
        // l'utilisateur enregistrera, enverra à l'imprimante ou jettera.
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

/// G-code provisoire d'un aperçu.
pub fn preview_gcode(id: &str) -> Option<PathBuf> {
    previews().lock().unwrap().get(id).map(|p| p.gcode.clone())
}

/// Enregistre l'aperçu sous un nom parlant, à côté du modèle par défaut.
/// L'aperçu reste disponible (pour un envoi à l'imprimante, par exemple).
pub fn save(id: &str, dir: Option<&str>) -> Result<PathBuf> {
    // Chemins relevés sous le verrou, copie faite hors de lui.
    let (gcode, dest) = {
        let list = previews().lock().unwrap();
        let p = list.get(id).ok_or_else(|| anyhow!("aperçu introuvable ; relancez la découpe"))?;
        let dest_dir = dir
            .map(PathBuf::from)
            .or_else(|| p.out_dir.clone())
            .or_else(|| p.source.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir);
        (p.gcode.clone(), dest_dir.join(output_name(&p.source, &p.gcode)))
    };
    std::fs::copy(&gcode, &dest).map_err(|e| anyhow!("copie du G-code impossible : {e}"))?;
    Ok(dest)
}

/// Modèle d'origine d'un aperçu.
pub fn preview_source(id: &str) -> Option<String> {
    previews().lock().unwrap().get(id).map(|p| p.source.to_string_lossy().to_string())
}

/// Nom de fichier proposé pour un aperçu (enregistrement, envoi).
pub fn preview_name(id: &str) -> Option<String> {
    let list = previews().lock().unwrap();
    let p = list.get(id)?;
    Some(output_name(&p.source, &p.gcode))
}

/// Abandonne un aperçu : son dossier de travail disparaît.
pub fn discard(id: &str) {
    if let Some(p) = previews().lock().unwrap().remove(id) {
        let _ = std::fs::remove_dir_all(&p.work);
    }
}

/// Supprime les dossiers de travail laissés par une session précédente
/// (application quittée avec un aperçu ouvert, plantage).
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

/// Crée le tube nommé par lequel le moteur annonce son avancement.
#[cfg(unix)]
fn progress_pipe(work: &Path) -> Option<PathBuf> {
    let p = work.join("progress.pipe");
    let _ = std::fs::remove_file(&p);
    let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).ok()?;
    // SAFETY : chemin C valide, terminé par un zéro, le temps de l'appel.
    let r = unsafe { libc::mkfifo(c.as_ptr(), 0o600) };
    (r == 0).then_some(p)
}

#[cfg(not(unix))]
fn progress_pipe(_work: &Path) -> Option<PathBuf> {
    None
}

/// Ouvre le tube en lecture, avant le lancement : le moteur l'ouvre en
/// écriture non bloquante, ce qui échoue tant qu'aucun lecteur n'existe.
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

/// Lit les lignes JSON `{"total_percent": …, "message": …}` du moteur
/// jusqu'à ce que `stop` passe à vrai.
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
            // Rien à lire : pas encore d'écrivain, ou tube vide.
            _ if done => break,
            _ => std::thread::sleep(pause),
        }
    }
}

/// Une ligne du moteur : avancement global et message éventuel.
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
    // SAFETY : simple envoi de signal à un processus que nous avons lancé.
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
}

#[cfg(windows)]
fn terminate(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    crate::util::no_window(&mut cmd);
    let _ = cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).status();
}

/// Interrompt une découpe en cours.
pub fn cancel(id: &str) -> bool {
    let pid = jobs().lock().unwrap().remove(id);
    match pid {
        Some(pid) => {
            // Le moteur n'a rien à sauvegarder, le dossier de travail est
            // nettoyé par le fil qui l'attend.
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
        println!("moteur : {}", bin.display());
        assert!(bin.is_file());
    }

    #[test]
    fn lists_are_filtered() {
        let Ok(l) = lists(None) else { return };
        println!(
            "{} machines, {} process, {} filaments, {} têtes",
            l.machines.len(),
            l.processes.len(),
            l.filaments.len(),
            l.extruders
        );
        assert!(!l.machines.is_empty());
        assert!(!l.processes.is_empty(), "process compatibles avec la machine retenue");
    }

    /// Déroulé complet : préparation, découpe, fichier déposé au bon endroit.
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
        println!("étapes : {phases:?}");
        if let Some(last) = got.last() {
            println!(
                "dernier : {} en {:.1} s, message {:?}, fichier {:?}",
                last.phase, last.elapsed_s, last.message, last.gcode
            );
        }
        assert_eq!(phases.first(), Some(&"preparation"));
        assert!(phases.contains(&"slicing"));
        let last = got.last().unwrap();
        assert_eq!(last.phase, "preview", "message : {:?}", last.message);
        let stats = last.stats.clone().expect("bilan joint à l'aperçu");
        println!("bilan : {stats:?}");
        assert!(stats.print_time_s.unwrap_or(0) > 0, "temps estimé");
        let tmp = PathBuf::from(last.gcode.clone().unwrap());
        assert!(tmp.is_file(), "aperçu dans le dossier de travail");
        let g = save("test", None).unwrap();
        assert!(g.is_file(), "le G-code est déposé");
        assert!(g.starts_with(&out_dir), "dans le dossier demandé");
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
        println!("« {process} » → {d:?}");
        assert!(d.layer_height.unwrap_or(0.0) > 0.0);
        assert!(d.infill.unwrap_or(-1.0) >= 0.0, "remplissage lu");
        assert!(d.walls.unwrap_or(0) >= 1, "parois lues");

        // Rien de touché, rien de réécrit.
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
        assert_eq!(o["sparse_infill_density"], "25%", "le moteur attend un pourcentage");
        assert_eq!(o["wall_loops"], "3");
        assert_eq!(o["enable_support"], "1");
        assert_eq!(o["brim_type"], "no_brim");
    }

    /// Une hauteur de couche imposée doit se retrouver dans le G-code produit.
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
            "couche demandée 0,30 mm → {:?} annoncé, {} couches, {:.1} s",
            d.meta.layer_height,
            d.layers + 1,
            last.elapsed_s
        );
        assert_eq!(d.meta.layer_height, Some(0.3), "la hauteur de couche imposée est appliquée");
    }

    /// Un projet à géométrie externe — l'extension « production » — faisait
    /// planter le moteur sans le moindre message. La géométrie est désormais
    /// réémise en un seul bloc avant d'être découpée.
    #[test]
    fn production_extension_project_slices() {
        let (Some(app), Ok(model)) = (engine(), std::env::var("PROJECT_MODEL")) else {
            return;
        };
        // Le fichier doit bien être du type qui posait problème.
        let z = crate::model3mf::open(Path::new(&model)).unwrap();
        let names = crate::model3mf::entry_names(&z);
        assert!(
            names.iter().any(|n| n.starts_with("3D/Objects/")),
            "ce test vise un 3MF à géométrie externe"
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
        assert!(none.is_none(), "message vide ignoré, octets nuls tolérés");
    }

    /// Extrudeurs employés : ceux des pièces, celui de l'objet pour les pièces
    /// qui n'en déclarent pas ; filaments du projet lus avec leur couleur.
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
        // Pièce 3 sans extrudeur : celui de l'objet (1) ; l'objet 9, sans pièce, le 4.
        assert_eq!(info.used, vec![1, 2, 3, 4]);
        assert_eq!(info.filaments.len(), 2);
        assert_eq!(info.filaments[0].color.as_deref(), Some("#ff0000"));
        assert_eq!(info.filaments[1].kind, "PETG");
        let _ = std::fs::remove_file(&tmp);
    }

    /// Un modèle à deux extrudeurs devient un objet à deux pièces, chacune sur
    /// la tête demandée.
    #[test]
    fn multicolor_model_keeps_its_heads() {
        use crate::mesh::{Mat, Tri};
        let tmp = std::env::temp_dir().join("snapstudio-multicolor-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let tri = |z: f32| Tri { v: [[0., 0., z], [10., 0., z], [0., 10., z + 1.]], c: [200, 30, 30] };
        let src = tmp.join("deux.3mf");
        crate::write3mf::write_multipart(
            &src,
            "deux",
            &[
                crate::write3mf::Part { name: "bas".into(), tris: vec![tri(0.)], extruder: 1 },
                crate::write3mf::Part { name: "haut".into(), tris: vec![tri(20.)], extruder: 2 },
            ],
            &Mat::IDENTITY,
        )
        .unwrap();
        let info = model_info(&src).unwrap();
        assert_eq!(info.used, vec![1, 2]);

        // Extrudeur 1 → tête 3, extrudeur 2 → tête 0.
        let out = rewrite_centered(&src, &tmp, (270.0, 270.0), &[3, 0]).unwrap();
        let mut zip = crate::model3mf::open(&out).unwrap();
        let m = crate::mesh::load_mesh(&mut zip, 1_000).unwrap();
        assert_eq!(m.extruders.len(), m.tris.len());
        let low = m.tris.iter().position(|t| t.v[0][2] < 1.0).unwrap();
        let high = m.tris.iter().position(|t| t.v[0][2] > 10.0).unwrap();
        assert_eq!(m.extruders[low], 4, "bas sur la tête 3");
        assert_eq!(m.extruders[high], 1, "haut sur la tête 0");
        assert!(m.tris[high].v[0][2] > 15.0, "la pièce haute reste en hauteur");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Découpe réelle d'un modèle bicolore (machine avec le moteur installé).
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
        // Deux cubes de 10 mm superposés.
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
        println!("têtes employées : {tools:?}");
        assert!(tools.contains(&0) && tools.contains(&1), "les deux têtes extrudent");
        discard("bicolore");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Découpe réelle d'une scène du plateau : deux objets placés, l'un tourné ;
    /// le G-code doit les trouver là où le plateau les a mis.
    /// Test de fumée d'un moteur : profils U1 0,4 mm réels, deux cubes sur
    /// deux têtes. Lancé par la CI « moteur » sur chaque moteur allégé :
    /// `SNAPSTUDIO_ENGINE=… cargo test --lib engine_smoke -- --ignored`.
    #[test]
    #[ignore]
    fn engine_smoke() {
        let app = engine().expect("SNAPSTUDIO_ENGINE : moteur à éprouver");
        println!("moteur : {}", app.display());
        let machine = "Snapmaker U1 (0.4 nozzle)".to_string();
        let l = lists(Some(&machine)).expect("profils lisibles dans le moteur");
        assert!(l.machines.iter().any(|m| m.name == machine), "profil machine U1 0,4");
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
        // Un cube par tête : T0 et T1.
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
        assert_eq!(last.phase, "preview", "découpe échouée : {:?}", last.message);
        let path = last.gcode.clone().unwrap();
        let stats = last.stats.clone().expect("bilan");
        println!("G-code en {:.1} s : {} · {:?} · têtes {:?}", t0.elapsed().as_secs_f32(), path, stats.print_time_s, stats.tools);
        assert!(std::fs::metadata(&path).unwrap().len() > 10_000, "G-code non vide");
        assert!(stats.tools.contains(&0) && stats.tools.contains(&1), "les deux têtes servent");
        discard("smoke");
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
        println!("emprise du G-code : {:?} → {:?}", g.min, g.max);
        assert!(g.min[0] > 40.0 && g.max[0] < 200.0, "les cubes restent autour de X = 60 et X = 180");
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
        println!("nom de sortie : {n}");
        assert!(n.starts_with("Ma piece"));
        assert!(n.ends_with(".gcode"));
    }
}
