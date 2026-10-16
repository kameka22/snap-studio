//! Library: browsing model sites.
//!
//! Each tab is a **native web view** added to our window. These views draw on
//! top of the HTML interface: the interface dictates their rectangle, and must
//! hide them as soon as a dialog or the 3D viewer comes in front.
//!
//! Cookies are those of the shared, persistent store: one logs in to
//! MakerWorld or Printables once, and the session survives a restart.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Current browser identity: some sites serve a degraded page to an unknown
/// agent.
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                  (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

#[derive(Serialize, Clone)]
pub struct Site {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
}

pub const SITES: &[Site] = &[
    Site { id: "makerworld", name: "MakerWorld", url: "https://makerworld.com/" },
    Site { id: "printables", name: "Printables", url: "https://www.printables.com/" },
    Site { id: "thingiverse", name: "Thingiverse", url: "https://www.thingiverse.com/" },
    Site { id: "cults3d", name: "Cults3D", url: "https://cults3d.com/fr" },
];

pub fn sites() -> Vec<Site> {
    SITES.to_vec()
}

fn label(id: &str) -> String {
    format!("lib-{id}")
}

/// Rectangle of the browsing area, in interface points.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Last known rectangle: a view created later goes straight there.
///
/// Never hold it across a window or webview call: off the main thread
/// (`lib_open` is async, for Windows), those calls wait for the main thread,
/// which may itself be waiting for this lock in `lib_rect` — a deadlock that
/// froze the app on macOS. Copy the rectangle out first.
fn last_rect() -> &'static Mutex<Rect> {
    static R: OnceLock<Mutex<Rect>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Rect { x: 0.0, y: 0.0, w: 800.0, h: 600.0 }))
}

/// Open tabs, in opening order.
fn tabs() -> &'static Mutex<Vec<String>> {
    static T: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Vec::new()))
}

/// Opens a tab, or brings it back to the front if it already exists. `id`
/// names the tab, not the site: a site may be open in several tabs.
pub fn open_tab(app: &AppHandle, id: &str, url: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(anyhow!("bad tab id: {id}"));
    }
    let lbl = label(id);
    if app.get_webview(&lbl).is_some() {
        show_only(app, Some(id));
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| anyhow!("main window not found"))?;
    let target = url::Url::parse(url)?;

    let handle = app.clone();
    let tab_id = id.to_string();
    let nav_id = tab_id.clone();
    let dl_app = handle.clone();
    let dl_id = tab_id.clone();
    let nw_app = handle.clone();
    let nw_label = lbl.clone();
    let title_app = handle.clone();
    let title_id = tab_id.clone();

    let builder = tauri::WebviewBuilder::new(&lbl, WebviewUrl::External(target))
        .user_agent(UA)
        // The address shown is the page's: frames navigate too (ads,
        // `about:blank`…), so it is taken when the main page loads, and
        // when its title changes (sites that change pages without loading).
        .on_page_load(move |webview, _payload| {
            emit_url(&handle, &nav_id, &webview);
        })
        .on_download(move |_webview, event| download_hook(&dl_app, &dl_id, event))
        // Sites happily open a side window — third-party login, or starting a
        // download. It is brought back into the current tab rather than letting a
        // bare window pop up.
        .on_new_window(move |url, _features| {
            if let Some(wv) = nw_app.get_webview(&nw_label) {
                let _ = wv.navigate(url);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        // The page title names the tab: several tabs of one site stay apart.
        .on_document_title_changed(move |webview, title| {
            let _ = title_app.emit("lib-title", serde_json::json!({ "id": title_id, "title": title }));
            emit_url(&title_app, &title_id, &webview);
        });

    let r = *last_rect().lock().unwrap();
    let dy = title_offset(&window);
    window.add_child(
        builder,
        LogicalPosition::new(r.x, r.y + dy),
        LogicalSize::new(r.w.max(1.0), r.h.max(1.0)),
    )?;
    tabs().lock().unwrap().push(id.to_string());
    show_only(app, Some(id));
    Ok(())
}

/// Tells the UI a tab's address, when it is a web page's.
fn emit_url(app: &AppHandle, id: &str, webview: &tauri::Webview) {
    let Ok(url) = webview.url() else { return };
    if matches!(url.scheme(), "http" | "https") {
        let _ = app.emit("lib-url", serde_json::json!({ "id": id, "url": url.to_string() }));
    }
}

/// The address of a tab's page, when it is a web page's.
pub fn page_url(app: &AppHandle, id: &str) -> Option<String> {
    let url = app.get_webview(&label(id))?.url().ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// Forced download destination and notice to the UI.
fn download_hook(app: &AppHandle, id: &str, event: tauri::webview::DownloadEvent<'_>) -> bool {
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            let name = destination
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "modele.3mf".into());
            let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
            *destination = unique_path(&dir, &name);
            let _ = app.emit(
                "lib-download",
                serde_json::json!({
                    "id": id,
                    "phase": "started",
                    "url": url.to_string(),
                    "path": destination.to_string_lossy(),
                }),
            );
            true
        }
        tauri::webview::DownloadEvent::Finished { url, path, success } => {
            let _ = app.emit(
                "lib-download",
                serde_json::json!({
                    "id": id,
                    "phase": if success { "finished" } else { "failed" },
                    "url": url.to_string(),
                    "path": path.map(|p| p.to_string_lossy().to_string()),
                }),
            );
            true
        }
        _ => true,
    }
}

/// Adds a numbered suffix rather than overwriting an existing file.
fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    for i in 2..1000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    p
}

/// Title bar height, in points.
///
/// wry places a child view relative to the **whole window**, whereas our CSS
/// coordinates start at the top of the page, under the title bar. Without a
/// correction the page moves up and covers our address bar.
///
/// `outer_size` and `inner_size` return the same value here — the window has a
/// full-height content view — so the title bar is deduced from the gap between
/// the height the window declares and our page's, which the UI sends us.
/// Measured, never hard-coded.
fn title_offset(window: &tauri::Window) -> f64 {
    let viewport = *viewport_h().lock().unwrap();
    if viewport <= 0.0 {
        return 0.0;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    match window.inner_size() {
        Ok(s) => (s.to_logical::<f64>(scale).height - viewport).clamp(0.0, 200.0),
        Err(_) => 0.0,
    }
}

/// Page height as the UI measures it.
fn viewport_h() -> &'static Mutex<f64> {
    static V: OnceLock<Mutex<f64>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(0.0))
}

/// Places a view in the requested rectangle, corrected for the title bar.
fn place(wv: &tauri::Webview, rect: Rect) {
    let w = wv.window();
    let dy = title_offset(&w);
    if std::env::var("SNAPSTUDIO_LIBDEBUG").is_ok() {
        let scale = w.scale_factor().unwrap_or(1.0);
        eprintln!(
            "[lib] asked y={:.1} h={:.1} | title offset {:.1} | scale {:.2} | \
             inner {:?} | outer {:?} | view position before {:?}",
            rect.y, rect.h, dy, scale,
            w.inner_size().map(|s| s.to_logical::<f64>(scale).height).ok(),
            w.outer_size().map(|s| s.to_logical::<f64>(scale).height).ok(),
            wv.position().map(|p| p.to_logical::<f64>(scale).y).ok(),
        );
    }
    let _ = wv.set_position(LogicalPosition::new(rect.x, rect.y + dy));
    let _ = wv.set_size(LogicalSize::new(rect.w.max(1.0), rect.h.max(1.0)));
    if std::env::var("SNAPSTUDIO_LIBDEBUG").is_ok() {
        let scale = w.scale_factor().unwrap_or(1.0);
        eprintln!(
            "[lib] view position after {:?}",
            wv.position().map(|p| p.to_logical::<f64>(scale).y).ok()
        );
    }
}

/// Shows a tab and hides the others; `None` hides them all.
pub fn show_only(app: &AppHandle, id: Option<&str>) {
    let wanted = id.map(label);
    // Copied out, the lock released: `place` waits for the main thread.
    let rect = *last_rect().lock().unwrap();
    for (lbl, wv) in app.webviews() {
        if !lbl.starts_with("lib-") {
            continue;
        }
        if Some(&lbl) == wanted.as_ref() {
            place(&wv, rect);
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
}

/// Remembers the browsing area and puts the visible view back in it.
pub fn set_rect(app: &AppHandle, rect: Rect, viewport: f64, visible: Option<&str>) {
    *last_rect().lock().unwrap() = rect;
    if viewport > 0.0 {
        *viewport_h().lock().unwrap() = viewport;
    }
    if let Some(id) = visible {
        if let Some(wv) = app.get_webview(&label(id)) {
            place(&wv, rect);
        }
    }
}

pub fn close_tab(app: &AppHandle, id: &str) {
    if let Some(wv) = app.get_webview(&label(id)) {
        let _ = wv.close();
    }
    tabs().lock().unwrap().retain(|t| t != id);
}

pub fn navigate(app: &AppHandle, id: &str, url: &str) -> Result<()> {
    let wv = app
        .get_webview(&label(id))
        .ok_or_else(|| anyhow!("unknown tab"))?;
    wv.navigate(url::Url::parse(url)?)?;
    Ok(())
}

/// History and reload: the remote view does not have our bridge, so we go
/// through its own JavaScript context.
pub fn command(app: &AppHandle, id: &str, what: &str) -> Result<()> {
    let wv = app
        .get_webview(&label(id))
        .ok_or_else(|| anyhow!("unknown tab"))?;
    let js = match what {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(anyhow!("unknown command: {what}")),
    };
    wv.eval(js)?;
    Ok(())
}

/// Registrable domain: "www.printables.com" gives "printables.com".
fn registrable(host: &str) -> String {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 2 {
        parts[parts.len() - 2..].join(".")
    } else {
        host.to_string()
    }
}

/// Logs a site out by deleting only its login cookies, from one of its tabs.
///
/// The cookie store is shared by all views: clearing it wholesale would log
/// the other sites out too. So it is filtered by domain.
pub fn logout(app: &AppHandle, tab: &str, site: &str) -> Result<usize> {
    let site = SITES
        .iter()
        .find(|s| s.id == site)
        .ok_or_else(|| anyhow!("unknown site"))?;
    let wv = app
        .get_webview(&label(tab))
        .ok_or_else(|| anyhow!(crate::t!("err.tab_closed")))?;
    let host = url::Url::parse(site.url)?
        .host_str()
        .unwrap_or_default()
        .to_string();
    let base = registrable(&host);

    let mut n = 0;
    for c in wv.cookies()? {
        let dom = c.domain().unwrap_or_default().trim_start_matches('.').to_string();
        if dom.ends_with(&base) {
            if wv.delete_cookie(c).is_ok() {
                n += 1;
            }
        }
    }
    let _ = wv.navigate(url::Url::parse(site.url)?);
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sites_are_well_formed() {
        for s in sites() {
            assert!(url::Url::parse(s.url).is_ok(), "{} : URL valide", s.name);
            assert!(!s.id.is_empty());
        }
    }

    #[test]
    fn registrable_domain() {
        assert_eq!(registrable("www.printables.com"), "printables.com");
        assert_eq!(registrable("makerworld.com"), "makerworld.com");
        assert_eq!(registrable("a.b.cults3d.com"), "cults3d.com");
        assert_eq!(registrable("localhost"), "localhost");
    }

    #[test]
    fn unique_path_avoids_overwriting() {
        let dir = std::env::temp_dir().join("snapstudio_dl_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_path(&dir, "piece.3mf");
        assert_eq!(first.file_name().unwrap(), "piece.3mf");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(&dir, "piece.3mf");
        assert_eq!(second.file_name().unwrap(), "piece (2).3mf");
    }
}
