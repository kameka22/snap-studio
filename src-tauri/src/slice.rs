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

/// Application servant de moteur : Snapmaker Orca de préférence.
pub fn engine() -> Option<PathBuf> {
    let list = crate::slicers::list();
    list.iter()
        .find(|s| s.name == "Snapmaker Orca")
        .or_else(|| list.first())
        .map(|s| PathBuf::from(&s.path))
}

fn binary(app: &Path) -> Result<PathBuf> {
    let macos = app.join("Contents/MacOS");
    let rd = std::fs::read_dir(&macos)?;
    for e in rd.flatten() {
        let p = e.path();
        // L'exécutable principal porte le nom de l'application, les autres
        // binaires du paquet sont des utilitaires.
        if p.is_file() && p.file_name().map(|n| n != "crashpad_handler").unwrap_or(false) {
            return Ok(p);
        }
    }
    Err(anyhow!("exécutable introuvable dans {}", macos.display()))
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
}

/// Listes proposables, filtrées pour la machine demandée.
pub fn lists(machine: Option<&str>) -> Result<PresetLists> {
    let app = engine().ok_or_else(|| anyhow!("aucun trancheur détecté"))?;
    let idx = index_for(&app)?;
    let machines = idx.machines();
    let chosen = machine
        .map(String::from)
        .or_else(|| idx.selected.get("machine").cloned())
        .filter(|m| machines.iter().any(|x| &x.name == m))
        .or_else(|| machines.first().map(|m| m.name.clone()))
        .ok_or_else(|| anyhow!("aucune machine disponible"))?;
    Ok(PresetLists {
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
    let app = engine().ok_or_else(|| anyhow!("aucun trancheur détecté"))?;
    let idx = index_for(&app)?;
    let _ = machine;
    let cfg = idx
        .flatten(process)
        .ok_or_else(|| anyhow!("préréglage inconnu : {process}"))?;
    Ok(Simple::from_config(&cfg))
}

#[derive(Deserialize, Clone)]
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
}

#[derive(Serialize, Clone)]
pub struct Progress {
    pub id: String,
    /// preparation | slicing | done | error | cancelled
    pub phase: String,
    pub elapsed_s: f32,
    pub message: Option<String>,
    pub gcode: Option<String>,
}

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
fn rewrite_centered(source: &Path, work: &Path, plate: (f32, f32)) -> Result<PathBuf> {
    let mut zip = crate::model3mf::open(source)?;
    let m = crate::mesh::load_mesh(&mut zip, SLICE_TRI_BUDGET)?;
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
    crate::write3mf::write_scene(
        &dst,
        &[crate::write3mf::SceneObject {
            name,
            tris: m.tris,
            transform: t,
            extruder: None,
        }],
    )?;
    Ok(dst)
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
    let engine_app = engine().ok_or_else(|| anyhow!("aucun trancheur détecté"))?;
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
        });

        let work = std::env::temp_dir().join(format!("snapstudio_slice_{job_id}"));
        let fail = |msg: String| {
            report(Progress {
                id: job_id.clone(),
                phase: "error".into(),
                elapsed_s: el(&t0),
                message: Some(msg),
                gcode: None,
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
        let source = Path::new(&req.source);
        let mut arrange = "0";
        let input = if crate::scan::kind_of(source) == Some("3mf") {
            match rewrite_centered(source, &work, idx.plate_size(&req.machine)) {
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
        });

        let child = std::process::Command::new(&bin)
            .args(["--arrange", arrange, "--allow-newer-file", "--slice", "0"])
            .arg("--load-settings").arg(&settings)
            .arg("--load-filaments").arg(&fils)
            .arg("--outputdir").arg(&out)
            .arg(&input)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let child = match child {
            Ok(c) => c,
            Err(e) => return fail(format!("moteur non lançable : {e}")),
        };
        jobs().lock().unwrap().insert(job_id.clone(), child.id());

        let output = match child.wait_with_output() {
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

        // Le résultat rejoint le dossier du modèle, sous un nom parlant.
        let dest_dir = req
            .out_dir
            .as_ref()
            .map(PathBuf::from)
            .or_else(|| source.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(std::env::temp_dir);
        let dest = dest_dir.join(output_name(source, first));
        if let Err(e) = std::fs::copy(first, &dest) {
            return fail(format!("copie du résultat impossible : {e}"));
        }
        let _ = std::fs::remove_dir_all(&work);

        report(Progress {
            id: job_id.clone(),
            phase: "done".into(),
            elapsed_s: el(&t0),
            message: None,
            gcode: Some(dest.to_string_lossy().to_string()),
        });
    }
}

/// Interrompt une découpe en cours.
pub fn cancel(id: &str) -> bool {
    let pid = jobs().lock().unwrap().remove(id);
    match pid {
        Some(pid) => {
            // SIGTERM : le moteur n'a rien à sauvegarder, le dossier de travail
            // est nettoyé par le fil qui l'attend.
            unsafe { libc::kill(pid as i32, libc::SIGTERM) };
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
        assert_eq!(last.phase, "done", "message : {:?}", last.message);
        let g = PathBuf::from(last.gcode.clone().unwrap());
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
            },
            "ovr".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "done", "message : {:?}", last.message);
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
            },
            "prod".into(),
            &move |p| sink.lock().unwrap().push(p),
        );
        let got = seen.lock().unwrap();
        let last = got.last().unwrap();
        assert_eq!(last.phase, "done", "message : {:?}", last.message);
        println!("→ {}", last.gcode.clone().unwrap());
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
