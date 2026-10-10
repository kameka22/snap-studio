//! Gestion des imprimantes et lecture de leur statut.
//!
//! La Snapmaker U1 embarque Klipper + Moonraker : le statut se lit en HTTP sur
//! l'API Moonraker, sans cloud ni authentification. Les mêmes requêtes
//! fonctionnent sur toute imprimante Klipper (Voron, Prusa Core One, etc.).

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Printer {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub note: String,
}

fn store_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("printers.json")
}

pub fn load() -> Vec<Printer> {
    std::fs::read(store_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(list: &[Printer]) -> Result<()> {
    let tmp = store_path().with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
    std::fs::rename(&tmp, store_path())?;
    Ok(())
}

pub fn new_id() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", crate::util::fnv1a(&[&n.to_le_bytes()]))
}

/* ------------------------------------------------------------- statut */

#[derive(Serialize, Default, Clone)]
pub struct Temp {
    pub current: f32,
    pub target: f32,
}

/// Une bobine chargée dans un des emplacements de la machine.
#[derive(Serialize, Clone, Default)]
pub struct Filament {
    pub index: u8,
    pub kind: String,
    pub sub_type: String,
    /// Couleur au format "#rrggbb".
    pub color: Option<String>,
    pub vendor: String,
    pub present: bool,
    /// Emplacement employé par l'impression en cours.
    pub used: bool,
}

/// La U1 possède quatre têtes (T0 à T3) : `extruder`, `extruder1`, `extruder2`, `extruder3`.
#[derive(Serialize, Clone)]
pub struct Nozzle {
    pub index: u8,
    pub current: f32,
    pub target: f32,
    pub active: bool,
}

#[derive(Serialize, Default, Clone)]
pub struct Status {
    pub online: bool,
    /// standby | printing | paused | complete | cancelled | error | offline
    pub state: String,
    pub message: Option<String>,
    pub hostname: Option<String>,
    pub klipper: Option<String>,
    pub job: Option<String>,
    /// 0.0 à 1.0
    pub progress: Option<f32>,
    pub elapsed_s: Option<f32>,
    pub remaining_s: Option<f32>,
    pub filament_mm: Option<f32>,
    pub nozzles: Vec<Nozzle>,
    pub filaments: Vec<Filament>,
    pub bed: Option<Temp>,
    pub chamber: Option<Temp>,
    pub fan: Option<f32>,
    pub speed_factor: Option<f32>,
    pub layer: Option<(u32, u32)>,
    pub error: Option<String>,
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(4))
            .connect_timeout(Duration::from_secs(2))
            .user_agent("Snap-Studio")
            .build()
            .expect("client HTTP")
    })
}

fn base(host: &str, port: u16) -> String {
    let h = host.trim().trim_end_matches('/');
    if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else {
        format!("http://{}:{}", h, port)
    }
}

async fn get_json(url: &str) -> Result<Value> {
    let r = client().get(url).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    Ok(r.json::<Value>().await?)
}

fn f32_of(v: &Value) -> Option<f32> {
    v.as_f64().map(|x| x as f32)
}

fn temp_of(v: Option<&Value>) -> Option<Temp> {
    let o = v?;
    Some(Temp {
        current: f32_of(o.get("temperature")?)?,
        target: o.get("target").and_then(f32_of).unwrap_or(0.0),
    })
}

/// Objets Klipper interrogés à chaque rafraîchissement.
const OBJECTS: &str = "print_task_config&print_stats&display_status&virtual_sdcard&extruder&extruder1&extruder2&extruder3&heater_bed&toolhead&gcode_move&fan";

pub async fn status(host: &str, port: u16) -> Status {
    let b = base(host, port);
    let mut st = Status {
        state: "offline".into(),
        ..Default::default()
    };

    // 1. Moonraker est-il joignable et Klipper prêt ?
    match get_json(&format!("{b}/server/info")).await {
        Ok(v) => {
            st.online = true;
            let r = v.get("result").unwrap_or(&Value::Null);
            st.klipper = r.get("klippy_state").and_then(|s| s.as_str()).map(String::from);
            if r.get("klippy_connected").and_then(|b| b.as_bool()) == Some(false) {
                st.state = "error".into();
                st.message = Some("Klipper n'est pas connecté à Moonraker".into());
            }
        }
        Err(e) => {
            st.message = Some(e.to_string());
            return st;
        }
    }

    if let Ok(v) = get_json(&format!("{b}/printer/info")).await {
        let r = v.get("result").unwrap_or(&Value::Null);
        st.hostname = r.get("hostname").and_then(|s| s.as_str()).map(String::from);
        if let Some(m) = r.get("state_message").and_then(|s| s.as_str()) {
            if r.get("state").and_then(|s| s.as_str()) != Some("ready") {
                st.message = Some(m.trim().to_string());
                st.state = "error".into();
            }
        }
    }

    // 2. Objets d'impression.
    let Ok(v) = get_json(&format!("{b}/printer/objects/query?{OBJECTS}")).await else {
        if st.state == "offline" {
            st.state = "standby".into();
        }
        return st;
    };
    apply_objects(&v, &mut st);
    st
}

/// Traduit la réponse de `/printer/objects/query` en statut affichable.
pub fn apply_objects(v: &Value, st: &mut Status) {
    let s = v
        .get("result")
        .and_then(|r| r.get("status"))
        .cloned()
        .unwrap_or(Value::Null);
    apply_status(&s, st);
}

/// Même traitement à partir de l'objet `status` seul (flux WebSocket).
pub fn apply_status(s: &Value, st: &mut Status) {
    if let Some(ps) = s.get("print_stats") {
        if let Some(state) = ps.get("state").and_then(|x| x.as_str()) {
            st.state = state.to_string();
        }
        st.job = ps
            .get("filename")
            .and_then(|x| x.as_str())
            .filter(|f| !f.is_empty())
            .map(String::from);
        st.elapsed_s = ps.get("print_duration").and_then(f32_of);
        st.filament_mm = ps.get("filament_used").and_then(f32_of);
        if let Some(m) = ps.get("message").and_then(|x| x.as_str()).filter(|m| !m.is_empty()) {
            st.message = Some(m.to_string());
        }
        if let Some(i) = ps.get("info") {
            let cur = i.get("current_layer").and_then(|x| x.as_u64());
            let tot = i.get("total_layer").and_then(|x| x.as_u64());
            if let (Some(c), Some(t)) = (cur, tot) {
                st.layer = Some((c as u32, t as u32));
            }
        }
    }

    // Progression : display_status si présent, sinon avancement dans le fichier.
    st.progress = s
        .get("display_status")
        .and_then(|d| d.get("progress"))
        .and_then(f32_of)
        .or_else(|| s.get("virtual_sdcard").and_then(|d| d.get("progress")).and_then(f32_of));

    // Estimation du temps restant à partir de la progression (Moonraker ne la fournit pas).
    if let (Some(p), Some(e)) = (st.progress, st.elapsed_s) {
        if p > 0.02 && p < 1.0 && st.state == "printing" {
            st.remaining_s = Some(e * (1.0 - p) / p);
        }
    }

    // Tête active : `toolhead.extruder` donne son nom ("extruder1" par exemple).
    let active = s
        .get("toolhead")
        .and_then(|t| t.get("extruder"))
        .and_then(|x| x.as_str())
        .unwrap_or("extruder")
        .to_string();
    for i in 0..4u8 {
        let key = if i == 0 { "extruder".to_string() } else { format!("extruder{i}") };
        if let Some(t) = temp_of(s.get(&key)) {
            st.nozzles.push(Nozzle {
                index: i,
                current: t.current,
                target: t.target,
                active: key == active,
            });
        }
    }

    apply_filaments(s.get("print_task_config"), st);

    st.bed = temp_of(s.get("heater_bed"));
    st.chamber = temp_of(s.get("chamber"));
    st.fan = s.get("fan").and_then(|f| f.get("speed")).and_then(f32_of);
    st.speed_factor = s
        .get("gcode_move")
        .and_then(|g| g.get("speed_factor"))
        .and_then(f32_of);
}

#[derive(Serialize)]
pub struct Probe {
    pub ok: bool,
    pub detail: String,
    pub hostname: Option<String>,
    pub api: Option<String>,
    /// Port qui a répondu : Moonraker écoute en 7125 et derrière nginx en 80.
    pub port: u16,
}

/// Vérifie une adresse saisie par l'utilisateur avant de l'enregistrer.
/// Essaie le port indiqué, puis l'autre port habituel de Moonraker.
pub async fn probe(host: &str, port: u16) -> Probe {
    let first = probe_one(host, port).await;
    if first.ok {
        return first;
    }
    let alt = if port == 7125 { 80 } else { 7125 };
    let second = probe_one(host, alt).await;
    if second.ok {
        return second;
    }
    first
}

async fn probe_one(host: &str, port: u16) -> Probe {
    let b = base(host, port);
    match get_json(&format!("{b}/printer/info")).await {
        Ok(v) => {
            let r = v.get("result").unwrap_or(&Value::Null);
            let hostname = r.get("hostname").and_then(|s| s.as_str()).map(String::from);
            let state = r.get("state").and_then(|s| s.as_str()).unwrap_or("?");
            return Probe {
                ok: true,
                detail: format!(
                    "Moonraker répond sur le port {port} — Klipper « {}»{}",
                    state,
                    hostname.as_deref().map(|h| format!(", hôte {h}")).unwrap_or_default()
                ),
                hostname,
                api: Some("moonraker".into()),
                port,
            };
        }
        Err(e1) => {
            // Repli : identification compatible OctoPrint.
            match get_json(&format!("{b}/api/version")).await {
                Ok(v) => Probe {
                    ok: true,
                    detail: format!(
                        "Réponse de {} sur le port {port}",
                        v.get("text").and_then(|s| s.as_str()).unwrap_or("l'imprimante")
                    ),
                    hostname: None,
                    api: Some("octoprint".into()),
                    port,
                },
                Err(e2) => Probe {
                    ok: false,
                    detail: format!("Aucune réponse sur le port {port} ({e1} ; {e2})"),
                    hostname: None,
                    api: None,
                    port,
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Réponse type d'une Snapmaker U1 (Klipper + Moonraker) en cours d'impression.
    const SAMPLE: &str = r#"{"result":{"eventtime":4210.1,"status":{
      "print_stats":{"filename":"Frame_200x200_PLA_1h28m.gcode","state":"printing",
        "print_duration":1832.4,"total_duration":1901.0,"filament_used":4218.7,"message":"",
        "info":{"current_layer":42,"total_layer":118}},
      "display_status":{"progress":0.3612},
      "virtual_sdcard":{"progress":0.3598,"is_active":true},
      "extruder":{"temperature":219.8,"target":220.0},
      "extruder1":{"temperature":168.2,"target":170.0},
      "extruder2":{"temperature":25.4,"target":0.0},
      "extruder3":{"temperature":25.1,"target":0.0},
      "heater_bed":{"temperature":59.8,"target":60.0},
      "toolhead":{"extruder":"extruder1","position":[110.2,98.4,8.6,214.3]},
      "gcode_move":{"speed_factor":1.15},
      "fan":{"speed":0.85}}}}"#;

    #[test]
    fn decode_u1_status() {
        let v: Value = serde_json::from_str(SAMPLE).unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);

        assert_eq!(st.state, "printing");
        assert_eq!(st.job.as_deref(), Some("Frame_200x200_PLA_1h28m.gcode"));
        assert_eq!(st.layer, Some((42, 118)));
        assert!((st.progress.unwrap() - 0.3612).abs() < 1e-4);
        // Temps restant déduit de la progression : 1832 s pour 36 % => ~3241 s.
        let rem = st.remaining_s.unwrap();
        assert!((rem - 3240.0).abs() < 60.0, "restant = {rem}");

        // Quatre têtes, la T1 active.
        assert_eq!(st.nozzles.len(), 4);
        assert_eq!(st.nozzles[1].index, 1);
        assert!(st.nozzles[1].active);
        assert!(!st.nozzles[0].active);
        assert!((st.nozzles[0].current - 219.8).abs() < 0.01);

        assert!((st.bed.as_ref().unwrap().target - 60.0).abs() < 0.01);
        assert!((st.fan.unwrap() - 0.85).abs() < 0.01);
        assert!((st.speed_factor.unwrap() - 1.15).abs() < 0.01);
    }

    /// Bobines chargées, au format réellement émis par la U1.
    #[test]
    fn decode_loaded_filaments() {
        let v: Value = serde_json::from_str(
            r#"{"result":{"status":{"print_task_config":{
              "filament_type":["PLA","PLA","PLA","PETG"],
              "filament_sub_type":["","","",""],
              "filament_color":[4294967295,4278190080,4278204278,4278190080],
              "filament_color_rgba":["FFFFFFFF","000000FF","003776FF","000000FF"],
              "filament_exist":[true,true,true,false],
              "filament_vendor":[],
              "extruders_used":[2]}}}}"#,
        )
        .unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);

        assert_eq!(st.filaments.len(), 4);
        assert_eq!(st.filaments[0].kind, "PLA");
        assert_eq!(st.filaments[0].color.as_deref(), Some("#ffffff"));
        assert_eq!(st.filaments[2].color.as_deref(), Some("#003776"));
        assert_eq!(st.filaments[3].kind, "PETG");
        assert!(st.filaments[1].present);
        assert!(!st.filaments[3].present, "T3 est signalé vide");
        assert!(st.filaments[2].used, "T2 est utilisé par le travail");
        assert!(!st.filaments[0].used);
    }

    /// Repli quand seul l'entier ARGB est fourni.
    #[test]
    fn decode_filament_color_from_int() {
        let v: Value = serde_json::from_str(
            r#"{"result":{"status":{"print_task_config":{
              "filament_type":["PLA"],"filament_color":[4278204278]}}}}"#,
        )
        .unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);
        assert_eq!(st.filaments[0].color.as_deref(), Some("#003776"));
        assert!(st.filaments[0].present, "type renseigné => emplacement occupé");
    }

    /// Une imprimante Klipper simple (une seule buse, pas de compteur de couches).
    #[test]
    fn decode_minimal_klipper() {
        let v: Value = serde_json::from_str(
            r#"{"result":{"status":{"print_stats":{"state":"standby","filename":""},
              "extruder":{"temperature":24.5,"target":0.0},
              "heater_bed":{"temperature":23.9,"target":0.0}}}}"#,
        )
        .unwrap();
        let mut st = Status::default();
        apply_objects(&v, &mut st);
        assert_eq!(st.state, "standby");
        assert!(st.job.is_none());
        assert_eq!(st.nozzles.len(), 1);
        assert!(st.nozzles[0].active);
        assert!(st.progress.is_none());
        assert!(st.remaining_s.is_none());
        assert!(st.filaments.is_empty(), "pas de print_task_config sur une Klipper ordinaire");
    }
}

fn str_at(v: Option<&Value>, i: usize) -> String {
    v.and_then(|a| a.get(i))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Couleur d'un emplacement : chaîne "RRGGBBAA" ou entier ARGB selon le micrologiciel.
fn slot_color(cfg: &Value, i: usize) -> Option<String> {
    if let Some(s) = cfg
        .get("filament_color_rgba")
        .and_then(|a| a.get(i))
        .and_then(|x| x.as_str())
    {
        let h = s.trim().trim_start_matches('#');
        if h.len() >= 6 {
            return Some(format!("#{}", &h[0..6].to_ascii_lowercase()));
        }
    }
    let n = cfg.get("filament_color")?.get(i)?.as_u64()?;
    Some(format!("#{:06x}", n & 0x00ff_ffff))
}

/// `print_task_config` : objet Klipper propre à la Snapmaker U1 décrivant les
/// bobines chargées, un tableau de quatre valeurs par champ.
pub fn apply_filaments(cfg: Option<&Value>, st: &mut Status) {
    let Some(cfg) = cfg else { return };
    let len = ["filament_type", "filament_exist", "filament_color_rgba", "filament_color"]
        .iter()
        .filter_map(|k| cfg.get(*k).and_then(|a| a.as_array()).map(|a| a.len()))
        .max()
        .unwrap_or(0)
        .min(8);

    // `extruders_used` liste soit des indices, soit un booléen par emplacement.
    let used = cfg.get("extruders_used").and_then(|x| x.as_array());
    let is_used = |i: usize| -> bool {
        let Some(u) = used else { return false };
        u.iter().enumerate().any(|(j, v)| match v {
            Value::Bool(b) => *b && j == i,
            Value::Number(n) => n.as_u64() == Some(i as u64),
            _ => false,
        })
    };

    for i in 0..len {
        let kind = str_at(cfg.get("filament_type"), i);
        let color = slot_color(cfg, i);
        let present = cfg
            .get("filament_exist")
            .and_then(|a| a.get(i))
            .and_then(|x| x.as_bool())
            .unwrap_or(!kind.is_empty());
        if kind.is_empty() && color.is_none() && !present {
            continue;
        }
        st.filaments.push(Filament {
            index: i as u8,
            kind,
            sub_type: str_at(cfg.get("filament_sub_type"), i),
            color,
            vendor: str_at(cfg.get("filament_vendor"), i),
            present,
            used: is_used(i),
        });
    }
}
