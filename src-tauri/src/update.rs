//! Mises à jour de l'application.
//!
//! Le plugin officiel lit `latest.json` sur la dernière release GitHub,
//! télécharge le paquet de la plateforme et vérifie sa signature avec la clé
//! publique de `tauri.conf.json` avant de l'installer : un fichier altéré ou
//! signé par un autre est refusé.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Mise à jour trouvée par la dernière vérification, en attente d'installation.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize, Clone)]
pub struct Available {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    /// Faux pour un paquet que l'application ne sait pas remplacer elle-même
    /// (Linux hors AppImage) : l'interface renvoie alors vers GitHub.
    pub installable: bool,
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Version installée.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Interroge GitHub ; `None` si l'application est à jour.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<Available>, String> {
    // `cargo tauri dev` : la version locale est toujours « en retard » sur
    // les releases, et il n'y a pas de paquet installé à remplacer.
    if cfg!(debug_assertions) {
        return Err("mises à jour désactivées en développement".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let out = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        installable: installable(),
    });
    *pending.0.lock().unwrap() = update;
    Ok(out)
}

/// Télécharge, vérifie et installe la mise à jour trouvée, puis relance
/// l'application. L'avancement part vers l'interface (`update-progress`).
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("aucune mise à jour en attente")?;
    let emitter = app.clone();
    let mut done = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = emitter.emit("update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

/// Sous Linux, seule une AppImage peut se remplacer elle-même ; son chemin
/// est fourni par le lanceur dans `APPIMAGE`.
fn installable() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}
