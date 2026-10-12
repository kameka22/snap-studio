//! Menus natifs : menus surgissants demandés par l'interface.
//!
//! L'interface décrit le menu (libellés, coches, séparateurs) ; chaque entrée
//! porte un identifiant `verbe:argument`. Un seul gestionnaire, installé au
//! démarrage, renvoie l'identifiant choisi à la webview sous l'événement `menu`.

use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, Runtime, Window};

/// Une entrée décrite par l'interface. Sans `id`, c'est un séparateur.
#[derive(Deserialize)]
pub struct Entry {
    id: Option<String>,
    #[serde(default)]
    label: String,
    checked: Option<bool>,
    #[serde(default = "yes")]
    enabled: bool,
    accel: Option<String>,
}

fn yes() -> bool {
    true
}

fn build<R: Runtime>(app: &AppHandle<R>, items: &[Entry]) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for e in items {
        match &e.id {
            None => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Some(id) => match e.checked {
                Some(c) => menu.append(&CheckMenuItem::with_id(
                    app, id, &e.label, e.enabled, c, e.accel.as_deref(),
                )?)?,
                None => menu.append(&MenuItem::with_id(
                    app, id, &e.label, e.enabled, e.accel.as_deref(),
                )?)?,
            },
        }
    }
    Ok(menu)
}

/// Dernier menu surgissant affiché. Sous Linux, l'affichage est asynchrone :
/// le menu doit survivre à la commande jusqu'au choix de l'utilisateur.
fn last_popup() -> &'static Mutex<Option<Menu<tauri::Wry>>> {
    static LAST: OnceLock<Mutex<Option<Menu<tauri::Wry>>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// Affiche un menu natif aux coordonnées de la page (points logiques).
#[tauri::command]
pub fn popup_menu(window: Window, items: Vec<Entry>, x: f64, y: f64) -> Result<(), String> {
    let menu = build(window.app_handle(), &items).map_err(|e| e.to_string())?;
    window
        .popup_menu_at(&menu, LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    *last_popup().lock().unwrap() = Some(menu);
    Ok(())
}

/// Gestionnaire unique : toute entrée choisie part vers la webview.
pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit("menu", id.to_string());
}

/// Barre de menus de l'application (macOS). Les raccourcis vivent ici, dans
/// les accélérateurs, et non dans le JavaScript de l'interface.
#[cfg(target_os = "macos")]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use tauri::menu::{AboutMetadata, Submenu};
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let sep = || PredefinedMenuItem::separator(app);

    let about = AboutMetadata {
        name: Some("Snap Studio".into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let app_sub = Submenu::with_items(app, "Snap Studio", true, &[
        &PredefinedMenuItem::about(app, Some("À propos de Snap Studio"), Some(about))?,
        &item("app:update", "Rechercher les mises à jour…", None)?,
        &sep()?,
        &item("nav:settings", "Réglages…", Some("CmdOrCtrl+,"))?,
        &sep()?,
        &PredefinedMenuItem::services(app, Some("Services"))?,
        &sep()?,
        &PredefinedMenuItem::hide(app, Some("Masquer Snap Studio"))?,
        &PredefinedMenuItem::hide_others(app, Some("Masquer les autres"))?,
        &PredefinedMenuItem::show_all(app, Some("Tout afficher"))?,
        &sep()?,
        &PredefinedMenuItem::quit(app, Some("Quitter Snap Studio"))?,
    ])?;
    let file_sub = Submenu::with_items(app, "Fichier", true, &[
        &item("files:open", "Ouvrir un dossier…", Some("CmdOrCtrl+O"))?,
        &item("files:refresh", "Actualiser", Some("CmdOrCtrl+R"))?,
        &sep()?,
        &item("file:plate", "Ajouter au plateau du trancheur", Some("CmdOrCtrl+Enter"))?,
        &item("file:reveal", "Afficher dans le Finder", Some("CmdOrCtrl+Shift+R"))?,
        &item("file:delete", "Mettre à la corbeille", Some("CmdOrCtrl+Backspace"))?,
        &sep()?,
        &PredefinedMenuItem::close_window(app, Some("Fermer la fenêtre"))?,
    ])?;
    let edit_sub = Submenu::with_items(app, "Édition", true, &[
        &PredefinedMenuItem::undo(app, Some("Annuler"))?,
        &PredefinedMenuItem::redo(app, Some("Rétablir"))?,
        &sep()?,
        &PredefinedMenuItem::cut(app, Some("Couper"))?,
        &PredefinedMenuItem::copy(app, Some("Copier"))?,
        &PredefinedMenuItem::paste(app, Some("Coller"))?,
        // Sélection native : champs, pages de la Bibliothèque, terminal. La vue
        // Fichiers intercepte ⌘A pour sélectionner ses fichiers.
        &PredefinedMenuItem::select_all(app, Some("Tout sélectionner"))?,
        &sep()?,
        &item("edit:find", "Rechercher", Some("CmdOrCtrl+F"))?,
    ])?;
    let view_sub = Submenu::with_items(app, "Présentation", true, &[
        &item("view:grid", "Vignettes", Some("CmdOrCtrl+1"))?,
        &item("view:list", "Liste", Some("CmdOrCtrl+2"))?,
        &sep()?,
        &item("nav:library", "Bibliothèque", Some("Alt+CmdOrCtrl+1"))?,
        &item("nav:ia", "IA", Some("Alt+CmdOrCtrl+2"))?,
        &item("nav:files", "Fichiers", Some("Alt+CmdOrCtrl+3"))?,
        &item("nav:prepare", "Préparer", Some("Alt+CmdOrCtrl+4"))?,
        &sep()?,
        &PredefinedMenuItem::fullscreen(app, Some("Plein écran"))?,
    ])?;
    let window_sub = Submenu::with_items(app, "Fenêtre", true, &[
        &PredefinedMenuItem::minimize(app, Some("Placer dans le Dock"))?,
        &PredefinedMenuItem::maximize(app, Some("Réduire/agrandir"))?,
    ])?;
    let help_sub = Submenu::with_items(app, "Aide", true, &[
        &item("welcome:open", "Assistant de bienvenue", None)?,
    ])?;
    let _ = window_sub.set_as_windows_menu_for_nsapp();
    let _ = help_sub.set_as_help_menu_for_nsapp();

    Menu::with_items(app, &[&app_sub, &file_sub, &edit_sub, &view_sub, &window_sub, &help_sub])
}
