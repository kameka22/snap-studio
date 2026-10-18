//! Printer management and status reading.
//!
//! The Snapmaker U1 embeds Klipper + Moonraker: status is read over HTTP from
//! the Moonraker API, without cloud nor authentication. The same requests work
//! on any Klipper printer (Voron, Prusa Core One, etc.).

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

/* ------------------------------------------------------------- status */

#[derive(Serialize, Default, Clone)]
pub struct Temp {
    pub current: f32,
    pub target: f32,
}

/// A spool loaded in one of the machine's slots.
#[derive(Serialize, Clone, Default)]
pub struct Filament {
    pub index: u8,
    pub kind: String,
    pub sub_type: String,
    /// Color in "#rrggbb" format.
    pub color: Option<String>,
    pub vendor: String,
    pub present: bool,
    /// Slot used by the current print.
    pub used: bool,
}

/// The U1 has four heads (T0 to T3): `extruder`, `extruder1`, `extruder2`, `extruder3`.
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
    /// 0.0 to 1.0
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
    /// Print objects unreadable this time (timeout…): the state is not the
    /// print's, it does not prove the print is over.
    #[serde(skip)]
    pub partial: bool,
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

pub(crate) fn base(host: &str, port: u16) -> String {
    let h = host.trim().trim_end_matches('/');
    if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else {
        format!("http://{}:{}", h, port)
    }
}

pub(crate) async fn get_json(url: &str) -> Result<Value> {
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

// ------------------------------------------------------------ sending a print

/// Client without a global timeout: an upload can last several minutes.
fn long_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .user_agent("Snap-Studio")
            .build()
            .expect("client HTTP")
    })
}

/// Launch options offered by Snapmaker Orca for the U1.
#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug)]
pub struct StartOptions {
    /// Automatic bed leveling.
    pub bed_leveling: bool,
    /// Extrusion flow calibration.
    pub flow_calibration: bool,
    /// Timelapse camera.
    pub timelapse: bool,
}

impl StartOptions {
    /// `print_task_config` keys, in the order Snapmaker Orca sends them.
    fn entries(&self) -> [(&'static str, bool); 3] {
        [
            ("auto_bed_leveling", self.bed_leveling),
            ("flow_calibrate", self.flow_calibration),
            ("time_lapse_camera", self.timelapse),
        ]
    }
}

/// Preparation G-code sent before the launch, as Snapmaker Orca does: tool
/// → head mapping, heads used, options.
///
/// Firmware ≥ 1.3.0: one `SET_PRINT_PREFERENCE` macro per option. Before: a
/// single `SET_PRINT_PREFERENCES` (`legacy`).
pub fn preprint_script(opts: &StartOptions, tools: &[u8], legacy: bool) -> String {
    let mut lines: Vec<String> = Vec::new();
    // The G-code tools are already the heads: identity mapping.
    for t in tools {
        lines.push(format!("SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER={t} MAP_EXTRUDER={t}"));
    }
    if !tools.is_empty() {
        let list: Vec<String> = tools.iter().map(|t| t.to_string()).collect();
        lines.push(format!("SET_PRINT_USED_EXTRUDERS EXTRUDERS={}", list.join(",")));
    }
    if legacy {
        let kv: Vec<String> = opts
            .entries()
            .iter()
            .map(|(k, v)| format!("{}={}", k.to_uppercase(), v))
            .collect();
        lines.push(format!("SET_PRINT_PREFERENCES {}", kv.join(" ")));
    } else {
        for (k, v) in opts.entries() {
            lines.push(format!("SET_PRINT_PREFERENCE KEY={k} VALUE={v}"));
        }
    }
    lines.join("\n")
}

/// Runs a G-code script; the error reports Klipper's answer.
pub async fn gcode_script(host: &str, port: u16, script: &str) -> Result<()> {
    let r = long_client()
        .post(format!("{}/printer/gcode/script", base(host, port)))
        .timeout(Duration::from_secs(30))
        .json(&serde_json::json!({ "script": script }))
        .send()
        .await?;
    if r.status().is_success() {
        return Ok(());
    }
    let code = r.status().as_u16();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    let msg = body
        .pointer("/error/message")
        .and_then(|v| v.as_str())
        .unwrap_or("unexpected response");
    Err(anyhow!("HTTP {code}: {msg}"))
}

/// True when Klipper does not know the command (older firmware).
pub fn is_unknown_command(err: &anyhow::Error) -> bool {
    let m = err.to_string().to_ascii_lowercase();
    m.contains("unknown command")
}

/// Pause, resume or cancel the running print.
pub async fn print_action(host: &str, port: u16, action: &str) -> Result<()> {
    let action = match action {
        "pause" | "resume" | "cancel" => action,
        _ => return Err(anyhow!("unknown action: {action}")),
    };
    let r = client()
        .post(format!("{}/printer/print/{action}", base(host, port)))
        .send()
        .await?;
    if !r.status().is_success() {
        return Err(anyhow!(crate::t!("err.printer_refuses", status = r.status())));
    }
    Ok(())
}

/// `print_task_config` as the printer sees it, to check the options.
pub async fn task_config(host: &str, port: u16) -> Option<Value> {
    let url = format!("{}/printer/objects/query?print_task_config", base(host, port));
    let v = get_json(&url).await.ok()?;
    v.pointer("/result/status/print_task_config").cloned()
}

/// Options the printer did not take into account (empty when all is well,
/// or when it does not expose them).
pub fn unapplied_options(cfg: &Value, opts: &StartOptions) -> Vec<&'static str> {
    opts.entries()
        .iter()
        .filter(|(k, want)| match cfg.get(*k) {
            Some(Value::Bool(b)) => b != want,
            Some(Value::Number(n)) => (n.as_f64().unwrap_or(0.0) != 0.0) != *want,
            Some(Value::String(s)) => matches!(s.to_ascii_lowercase().as_str(), "true" | "1") != *want,
            _ => false,
        })
        .map(|(k, _)| *k)
        .collect()
}

/// Uploads a G-code into `gcodes/` and, if asked, starts the print.
/// `progress(sent, total)` follows the bytes as they go.
pub async fn upload(
    host: &str,
    port: u16,
    path: &std::path::Path,
    remote_name: &str,
    start: bool,
    progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> Result<()> {
    let data = std::fs::read(path)?;
    let total = data.len() as u64;
    let chunks: Vec<Vec<u8>> = data.chunks(64 * 1024).map(|c| c.to_vec()).collect();
    let mut sent = 0u64;
    let stream = futures_util::stream::iter(chunks.into_iter().map(move |c| {
        sent += c.len() as u64;
        progress(sent, total);
        Ok::<Vec<u8>, std::io::Error>(c)
    }));
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), total)
        .file_name(remote_name.to_string())
        .mime_str("application/octet-stream")?;
    let form = reqwest::multipart::Form::new()
        .text("root", "gcodes")
        .text("print", if start { "true" } else { "false" })
        .part("file", part);
    let r = long_client()
        .post(format!("{}/server/files/upload", base(host, port)))
        .multipart(form)
        .send()
        .await?;
    if !r.status().is_success() {
        let code = r.status().as_u16();
        let body: Value = r.json().await.unwrap_or(Value::Null);
        let msg = body.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("refused");
        return Err(anyhow!(crate::t!("err.upload_refused", code = code, msg = msg)));
    }
    Ok(())
}

// ------------------------------------------------------------ camera

/// Calls a JSON-RPC method on Moonraker's websocket and waits for its answer.
/// Snapmaker's own methods (`camera.*`) are not relayed over HTTP by the U1's
/// nginx: the websocket is the only way.
pub async fn ws_call(host: &str, port: u16, method: &str, params: Value) -> Result<Value> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let h = host
        .trim()
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let url = if h.contains(':') { format!("ws://{h}/websocket") } else { format!("ws://{h}:{port}/websocket") };
    let run = async {
        let (mut ws, _) = tokio_tungstenite::connect_async(url.as_str()).await?;
        let req = serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": 1 });
        ws.send(Message::Text(req.to_string().into())).await?;
        while let Some(msg) = ws.next().await {
            let Message::Text(t) = msg? else { continue };
            let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
            if v.get("id").and_then(|i| i.as_i64()) != Some(1) {
                continue; // status notifications, unrelated
            }
            let _ = ws.close(None).await;
            if let Some(e) = v.get("error") {
                let msg = e.get("message").and_then(|m| m.as_str()).unwrap_or("erreur");
                return Err(anyhow!("{method} : {msg}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
        Err(anyhow!(crate::t!("err.ws_closed", method = method)))
    };
    tokio::time::timeout(Duration::from_secs(8), run)
        .await
        .map_err(|_| anyhow!(crate::t!("err.ws_no_answer", method = method)))?
}

/// Wakes the U1's camera: it then publishes a continuously renewed image,
/// and switches itself off unless restarted (about 10 s).
pub async fn camera_start(host: &str, port: u16) -> Result<()> {
    let r = ws_call(host, port, "camera.start_monitor", serde_json::json!({ "domain": "lan", "interval": 0 })).await?;
    match r.get("state").and_then(|s| s.as_str()) {
        Some("success") | None => Ok(()),
        Some(other) => Err(anyhow!(crate::t!("err.camera", err = other))),
    }
}

pub async fn camera_stop(host: &str, port: u16) -> Result<()> {
    ws_call(host, port, "camera.stop_monitor", serde_json::json!({ "domain": "lan" }))
        .await
        .map(|_| ())
}

/// Latest camera image (JPEG), as Snapmaker Orca reads it.
pub async fn camera_frame(host: &str, port: u16) -> Result<Vec<u8>> {
    let url = format!("{}/server/files/camera/monitor.jpg", base(host, port));
    let r = client().get(url).send().await?;
    if !r.status().is_success() {
        return Err(anyhow!("HTTP {}", r.status().as_u16()));
    }
    Ok(r.bytes().await?.to_vec())
}

/// Klipper objects queried at each refresh.
const OBJECTS: &str = "print_task_config&print_stats&display_status&virtual_sdcard&extruder&extruder1&extruder2&extruder3&heater_bed&toolhead&gcode_move&fan";

pub async fn status(host: &str, port: u16) -> Status {
    let b = base(host, port);
    let mut st = Status {
        state: "offline".into(),
        ..Default::default()
    };

    // 1. Is Moonraker reachable and Klipper ready?
    match get_json(&format!("{b}/server/info")).await {
        Ok(v) => {
            st.online = true;
            let r = v.get("result").unwrap_or(&Value::Null);
            st.klipper = r.get("klippy_state").and_then(|s| s.as_str()).map(String::from);
            if r.get("klippy_connected").and_then(|b| b.as_bool()) == Some(false) {
                st.state = "error".into();
                st.message = Some(crate::t!("err.klipper_not_connected"));
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

    // 2. Print objects.
    let Ok(v) = get_json(&format!("{b}/printer/objects/query?{OBJECTS}")).await else {
        if st.state == "offline" {
            st.state = "standby".into();
        }
        st.partial = true;
        return st;
    };
    apply_objects(&v, &mut st);
    st
}

/// Turns the `/printer/objects/query` answer into a displayable status.
pub fn apply_objects(v: &Value, st: &mut Status) {
    let s = v
        .get("result")
        .and_then(|r| r.get("status"))
        .cloned()
        .unwrap_or(Value::Null);
    apply_status(&s, st);
}

/// Same processing from the `status` object alone (WebSocket feed).
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

    // Progress: display_status if present, otherwise progress in the file.
    st.progress = s
        .get("display_status")
        .and_then(|d| d.get("progress"))
        .and_then(f32_of)
        .or_else(|| s.get("virtual_sdcard").and_then(|d| d.get("progress")).and_then(f32_of));

    // Remaining time estimated from the progress (Moonraker does not give it).
    if let (Some(p), Some(e)) = (st.progress, st.elapsed_s) {
        if p > 0.02 && p < 1.0 && st.state == "printing" {
            st.remaining_s = Some(e * (1.0 - p) / p);
        }
    }

    // Active head: `toolhead.extruder` gives its name ("extruder1" for instance).
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
    /// Port that answered: Moonraker listens on 7125 and behind nginx on 80.
    pub port: u16,
}

/// Checks an address typed by the user before saving it. Tries the given
/// port, then Moonraker's other usual port.
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
                detail: crate::t!(
                    "probe.moonraker",
                    port = port,
                    state = state,
                    host = hostname
                        .as_deref()
                        .map(|h| crate::t!("probe.host", host = h))
                        .unwrap_or_default()
                ),
                hostname,
                api: Some("moonraker".into()),
                port,
            };
        }
        Err(e1) => {
            // Fallback: OctoPrint-compatible identification.
            match get_json(&format!("{b}/api/version")).await {
                Ok(v) => Probe {
                    ok: true,
                    detail: crate::t!(
                        "probe.octoprint",
                        port = port,
                        name = v
                            .get("text")
                            .and_then(|s| s.as_str())
                            .map(String::from)
                            .unwrap_or_else(|| crate::t!("probe.the_printer"))
                    ),
                    hostname: None,
                    api: Some("octoprint".into()),
                    port,
                },
                Err(e2) => Probe {
                    ok: false,
                    detail: crate::t!("probe.none", port = port, e1 = e1, e2 = e2),
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

    /// Typical answer of a Snapmaker U1 (Klipper + Moonraker) while printing.
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
        // Remaining time from the progress: 1832 s for 36 % => ~3241 s.
        let rem = st.remaining_s.unwrap();
        assert!((rem - 3240.0).abs() < 60.0, "restant = {rem}");

        // Four heads, T1 active.
        assert_eq!(st.nozzles.len(), 4);
        assert_eq!(st.nozzles[1].index, 1);
        assert!(st.nozzles[1].active);
        assert!(!st.nozzles[0].active);
        assert!((st.nozzles[0].current - 219.8).abs() < 0.01);

        assert!((st.bed.as_ref().unwrap().target - 60.0).abs() < 0.01);
        assert!((st.fan.unwrap() - 0.85).abs() < 0.01);
        assert!((st.speed_factor.unwrap() - 1.15).abs() < 0.01);
    }

    /// Camera of a real U1: `CAMERA_HOST=192.168.x.x cargo test camera_on_real_printer`.
    #[test]
    fn camera_on_real_printer() {
        let Ok(host) = std::env::var("CAMERA_HOST") else { return };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            camera_start(&host, 80).await.expect("start");
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let mut sizes = Vec::new();
            for _ in 0..3 {
                let jpg = camera_frame(&host, 80).await.expect("image");
                assert_eq!(&jpg[..2], &[0xFF, 0xD8], "JPEG");
                sizes.push(jpg.len());
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            println!("images : {sizes:?} octets");
            camera_stop(&host, 80).await.expect("stop");
        });
    }

    /// Print preparation, as Snapmaker Orca sends it.
    #[test]
    fn preprint_script_matches_snapmaker_orca() {
        let o = StartOptions { bed_leveling: true, flow_calibration: false, timelapse: false };
        let s = preprint_script(&o, &[0, 2], false);
        assert_eq!(
            s,
            "SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=0\n\
             SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=2 MAP_EXTRUDER=2\n\
             SET_PRINT_USED_EXTRUDERS EXTRUDERS=0,2\n\
             SET_PRINT_PREFERENCE KEY=auto_bed_leveling VALUE=true\n\
             SET_PRINT_PREFERENCE KEY=flow_calibrate VALUE=false\n\
             SET_PRINT_PREFERENCE KEY=time_lapse_camera VALUE=false"
        );
        let old = preprint_script(&StartOptions::default(), &[1], true);
        assert!(old.ends_with(
            "SET_PRINT_PREFERENCES AUTO_BED_LEVELING=false FLOW_CALIBRATE=false TIME_LAPSE_CAMERA=false"
        ));
    }

    #[test]
    fn unapplied_options_are_reported() {
        let o = StartOptions { bed_leveling: true, flow_calibration: false, timelapse: true };
        let cfg = serde_json::json!({"auto_bed_leveling": true, "flow_calibrate": false, "time_lapse_camera": false});
        assert_eq!(unapplied_options(&cfg, &o), vec!["time_lapse_camera"]);
        assert!(unapplied_options(&serde_json::json!({}), &o).is_empty(), "nothing exposed: nothing to report");
    }

    /// Loaded spools, in the format the U1 actually emits.
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
        assert!(!st.filaments[3].present, "T3 is reported empty");
        assert!(st.filaments[2].used, "T2 is used by the job");
        assert!(!st.filaments[0].used);
    }

    /// Fallback when only the ARGB integer is given.
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
        assert!(st.filaments[0].present, "type given => slot occupied");
    }

    /// A plain Klipper printer (single nozzle, no layer counter).
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
        assert!(st.filaments.is_empty(), "no print_task_config on an ordinary Klipper");
    }
}

fn str_at(v: Option<&Value>, i: usize) -> String {
    v.and_then(|a| a.get(i))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Color of a slot: "RRGGBBAA" string or ARGB integer depending on firmware.
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

/// `print_task_config`: Klipper object specific to the Snapmaker U1
/// describing the loaded spools, an array of four values per field.
pub fn apply_filaments(cfg: Option<&Value>, st: &mut Status) {
    let Some(cfg) = cfg else { return };
    let len = ["filament_type", "filament_exist", "filament_color_rgba", "filament_color"]
        .iter()
        .filter_map(|k| cfg.get(*k).and_then(|a| a.as_array()).map(|a| a.len()))
        .max()
        .unwrap_or(0)
        .min(8);

    // `extruders_used` lists either indices, or a boolean per slot.
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
