//! Bibliothèque : navigation dans les sites de modèles.
//!
//! Chaque onglet est une **vue web native** ajoutée à notre fenêtre. Ces vues se
//! dessinent au-dessus de l'interface HTML : c'est l'interface qui leur dicte
//! leur rectangle, et qui doit les masquer dès qu'un dialogue ou le visualiseur
//! 3D passe devant.
//!
//! Les cookies sont ceux du magasin partagé et persistant : on se connecte une
//! fois à MakerWorld ou Printables, et la session survit au redémarrage.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Identité de navigateur courante : certains sites servent une page dégradée
/// à un agent inconnu.
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

/// Rectangle de la zone de navigation, en points d'interface.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Dernier rectangle connu : une vue créée plus tard s'y place directement.
fn last_rect() -> &'static Mutex<Rect> {
    static R: OnceLock<Mutex<Rect>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Rect { x: 0.0, y: 0.0, w: 800.0, h: 600.0 }))
}

/// Onglets ouverts, dans l'ordre d'ouverture.
fn tabs() -> &'static Mutex<Vec<String>> {
    static T: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Vec::new()))
}

/// Ouvre un onglet, ou le rappelle au premier plan s'il existe déjà.
pub fn open_tab(app: &AppHandle, id: &str, url: &str) -> Result<()> {
    let lbl = label(id);
    if app.get_webview(&lbl).is_some() {
        show_only(app, Some(id));
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| anyhow!("fenêtre principale introuvable"))?;
    let target = url::Url::parse(url)?;

    let handle = app.clone();
    let tab_id = id.to_string();
    let nav_id = tab_id.clone();
    let dl_app = handle.clone();
    let dl_id = tab_id.clone();
    let nw_app = handle.clone();
    let nw_id = tab_id.clone();
    let nw_label = lbl.clone();

    let builder = tauri::WebviewBuilder::new(&lbl, WebviewUrl::External(target))
        .user_agent(UA)
        .on_navigation(move |url| {
            let _ = handle.emit(
                "lib-url",
                serde_json::json!({ "id": nav_id, "url": url.to_string() }),
            );
            true
        })
        .on_download(move |_webview, event| download_hook(&dl_app, &dl_id, event))
        // Les sites ouvrent volontiers une fenêtre annexe — connexion par un
        // tiers, ou lancement d'un téléchargement. On la ramène dans l'onglet
        // courant plutôt que de laisser surgir une fenêtre nue.
        .on_new_window(move |url, _features| {
            let _ = nw_app.emit(
                "lib-url",
                serde_json::json!({ "id": nw_id, "url": url.to_string() }),
            );
            if let Some(wv) = nw_app.get_webview(&nw_label) {
                let _ = wv.navigate(url);
            }
            tauri::webview::NewWindowResponse::Deny
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

/// Destination imposée des téléchargements et signalement à l'interface.
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

/// Ajoute un suffixe numéroté plutôt que d'écraser un fichier existant.
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

/// Hauteur de la barre de titre, en points.
///
/// wry place une vue fille par rapport à la **fenêtre entière**, alors que nos
/// coordonnées CSS partent du haut de la page, sous la barre de titre. Sans
/// correction la page remonte et recouvre notre barre d'adresse.
///
/// `outer_size` et `inner_size` renvoient ici la même valeur — la fenêtre a une
/// vue de contenu pleine hauteur — donc la barre de titre se déduit de l'écart
/// entre la hauteur déclarée par la fenêtre et celle de notre page, que
/// l'interface nous transmet. Mesuré, jamais codé en dur.
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

/// Hauteur de la page telle que l'interface la mesure.
fn viewport_h() -> &'static Mutex<f64> {
    static V: OnceLock<Mutex<f64>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(0.0))
}

/// Place une vue dans le rectangle demandé, corrigé de la barre de titre.
fn place(wv: &tauri::Webview, rect: Rect) {
    let w = wv.window();
    let dy = title_offset(&w);
    if std::env::var("SNAPSTUDIO_LIBDEBUG").is_ok() {
        let scale = w.scale_factor().unwrap_or(1.0);
        eprintln!(
            "[lib] demandé y={:.1} h={:.1} | décalage titre {:.1} | échelle {:.2} | \
             intérieur {:?} | extérieur {:?} | position vue avant {:?}",
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
            "[lib] position vue après {:?}",
            wv.position().map(|p| p.to_logical::<f64>(scale).y).ok()
        );
    }
}

/// Affiche un onglet et masque les autres ; `None` les masque tous.
pub fn show_only(app: &AppHandle, id: Option<&str>) {
    let wanted = id.map(label);
    for (lbl, wv) in app.webviews() {
        if !lbl.starts_with("lib-") {
            continue;
        }
        if Some(&lbl) == wanted.as_ref() {
            place(&wv, *last_rect().lock().unwrap());
            let _ = wv.show();
        } else {
            let _ = wv.hide();
        }
    }
}

/// Mémorise la zone de navigation et y replace la vue visible.
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
        .ok_or_else(|| anyhow!("onglet inconnu"))?;
    wv.navigate(url::Url::parse(url)?)?;
    Ok(())
}

/// Historique et rechargement : la vue distante n'a pas notre pont, on passe
/// par son propre contexte JavaScript.
pub fn command(app: &AppHandle, id: &str, what: &str) -> Result<()> {
    let wv = app
        .get_webview(&label(id))
        .ok_or_else(|| anyhow!("onglet inconnu"))?;
    let js = match what {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(anyhow!("commande inconnue : {what}")),
    };
    wv.eval(js)?;
    Ok(())
}

/// Domaine enregistrable : « www.printables.com » donne « printables.com ».
fn registrable(host: &str) -> String {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() >= 2 {
        parts[parts.len() - 2..].join(".")
    } else {
        host.to_string()
    }
}

/// Déconnecte un site en supprimant ses seuls témoins de connexion.
///
/// Le magasin de cookies est partagé par toutes les vues : l'effacer en bloc
/// déconnecterait aussi les autres sites. On filtre donc sur le domaine.
pub fn logout(app: &AppHandle, id: &str) -> Result<usize> {
    let site = SITES
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| anyhow!("site inconnu"))?;
    let wv = app
        .get_webview(&label(id))
        .ok_or_else(|| anyhow!("onglet fermé"))?;
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

pub fn current_url(app: &AppHandle, id: &str) -> Option<String> {
    app.get_webview(&label(id))
        .and_then(|w| w.url().ok())
        .map(|u| u.to_string())
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
