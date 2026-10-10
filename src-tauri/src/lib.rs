mod menu;
mod migrate;
mod favorites;
mod gcode;
mod ia;
mod library;
mod mesh;
mod model3mf;
mod presets;
mod printers;
mod pty;
mod render;
mod scan;
mod slice;
mod slicers;
mod stl;
mod thumbs;
mod util;
mod write3mf;
mod watch;

use model3mf::ThumbPref;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use tauri::http::{Request, Response};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

// ---------------------------------------------------------------- DTO

#[derive(Serialize)]
pub struct FileDto {
    path: String,
    name: String,
    /// "3mf" ou "gcode"
    kind: String,
    /// Sous-dossier relatif au dossier scanne ("" si a la racine).
    rel: String,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
pub struct FilamentDto {
    kind: String,
    color: Option<String>,
    used_g: Option<f32>,
    used_m: Option<f32>,
}

#[derive(Serialize)]
pub struct MetaDto {
    path: String,
    title: Option<String>,
    designer: Option<String>,
    license: Option<String>,
    description: Option<String>,
    application: Option<String>,
    creation_date: Option<String>,
    objects: Vec<String>,
    print_time_s: Option<u32>,
    weight_g: Option<f32>,
    filaments: Vec<FilamentDto>,
    plates: usize,
    printer: Option<String>,
    has_embedded_thumb: bool,
}

#[derive(Serialize)]
pub struct AnalyzeDto {
    size_mm: [f32; 3],
    triangles: usize,
    approximated: bool,
}

#[derive(Serialize)]
pub struct PlaceDto {
    label: String,
    path: String,
}

#[derive(Serialize)]
pub struct CacheDto {
    bytes: u64,
}

// ---------------------------------------------------------------- commandes

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_folder(dir: String, recursive: bool) -> Result<Vec<FileDto>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("Dossier introuvable : {}", dir));
    }
    Ok(scan::scan_dir(&root, recursive)
        .into_iter()
        .map(|f| {
            let rel = f
                .path
                .parent()
                .and_then(|p| p.strip_prefix(&root).ok())
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            FileDto {
                path: f.path.to_string_lossy().to_string(),
                name: f.name,
                kind: f.kind.to_string(),
                rel,
                size: f.size,
                modified: f
                    .modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            }
        })
        .collect())
}

fn meta_of(path: &str) -> MetaDto {
    let mut dto = MetaDto {
        path: path.to_string(),
        title: None,
        designer: None,
        license: None,
        description: None,
        application: None,
        creation_date: None,
        objects: Vec::new(),
        print_time_s: None,
        weight_g: None,
        filaments: Vec::new(),
        plates: 0,
        printer: None,
        has_embedded_thumb: false,
    };
    if scan::kind_of(Path::new(path)) == Some("gcode") {
        if let Ok(f) = std::fs::File::open(path) {
            if let Ok(g) = gcode::parse(f) {
                dto.title = None;
                dto.application = g.meta.generator.or(g.meta.profile);
                dto.printer = g.meta.printer;
                dto.print_time_s = g.meta.print_time_s;
                dto.weight_g = g.meta.filament_g;
                dto.plates = 1;
                dto.has_embedded_thumb = true;
                dto.filaments = g
                    .meta
                    .filaments
                    .into_iter()
                    .map(|k| FilamentDto {
                        kind: k,
                        color: None,
                        used_g: None,
                        used_m: None,
                    })
                    .collect();
            }
        }
        return dto;
    }

    if let Ok(mut zip) = model3mf::open(Path::new(path)) {
        let m = model3mf::read_meta(&mut zip);
        dto.title = m.title;
        dto.designer = m.designer;
        dto.license = m.license;
        dto.description = m.description;
        dto.application = m.application;
        dto.creation_date = m.creation_date;
        dto.objects = m.object_names;
        dto.print_time_s = m.print_time_s;
        dto.weight_g = m.weight_g;
        dto.plates = m.plates;
        dto.printer = m.printer;
        dto.has_embedded_thumb = m.has_embedded_thumb;
        dto.filaments = m
            .filaments
            .into_iter()
            .map(|f| FilamentDto {
                kind: f.kind,
                color: f
                    .color
                    .map(|c| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])),
                used_g: f.used_g,
                used_m: f.used_m,
            })
            .collect();
    }
    dto
}

/// Metadonnees d'un lot de fichiers, lues en parallele.
#[tauri::command]
async fn read_metas(paths: Vec<String>) -> Vec<MetaDto> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4);
    let chunk = paths.len().div_ceil(workers).max(1);
    let mut out: Vec<MetaDto> = Vec::with_capacity(paths.len());
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        for part in paths.chunks(chunk) {
            handles.push(s.spawn(move || part.iter().map(|p| meta_of(p)).collect::<Vec<_>>()));
        }
        for h in handles {
            if let Ok(v) = h.join() {
                out.extend(v);
            }
        }
    });
    out
}

/// Analyse geometrique a la demande : encombrement reel et nombre de triangles.
#[tauri::command]
async fn analyze(path: String) -> Result<AnalyzeDto, String> {
    let mut zip = model3mf::open(Path::new(&path)).map_err(|e| e.to_string())?;
    let m = mesh::load_mesh(&mut zip, 2_500_000).map_err(|e| e.to_string())?;
    Ok(AnalyzeDto {
        size_mm: m.size(),
        triangles: m.tris.len(),
        approximated: m.truncated,
    })
}

#[tauri::command]
fn trash_files(paths: Vec<String>) -> Result<usize, String> {
    let n = paths.len();
    trash::delete_all(&paths).map_err(|e| e.to_string())?;
    Ok(n)
}

#[tauri::command]
fn reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(PathBuf::from(path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- bibliothèque

#[tauri::command]
fn lib_sites() -> Vec<library::Site> {
    library::sites()
}

#[tauri::command]
fn lib_open(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    library::open_tab(&app, &id, &url).map_err(|e| e.to_string())
}

#[tauri::command]
fn lib_close(app: tauri::AppHandle, id: String) {
    library::close_tab(&app, &id);
}

/// Affiche un onglet ; sans identifiant, masque toutes les vues — c'est ce
/// qu'on fait avant d'ouvrir un dialogue ou le visualiseur.
#[tauri::command]
fn lib_show(app: tauri::AppHandle, id: Option<String>) {
    library::show_only(&app, id.as_deref());
}

#[tauri::command]
fn lib_rect(
    app: tauri::AppHandle,
    rect: library::Rect,
    viewport: f64,
    visible: Option<String>,
) {
    library::set_rect(&app, rect, viewport, visible.as_deref());
}

#[tauri::command]
fn lib_navigate(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    library::navigate(&app, &id, &url).map_err(|e| e.to_string())
}

#[tauri::command]
fn lib_command(app: tauri::AppHandle, id: String, what: String) -> Result<(), String> {
    library::command(&app, &id, &what).map_err(|e| e.to_string())
}

/// Déconnexion d'un site : ses cookies seulement, pas ceux des autres.
#[tauri::command]
async fn lib_logout(app: tauri::AppHandle, id: String) -> Result<usize, String> {
    library::logout(&app, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn lib_url(app: tauri::AppHandle, id: String) -> Option<String> {
    library::current_url(&app, &id)
}

// ---------------------------------------------------------------- favoris

#[tauri::command]
fn fav_list() -> Vec<favorites::Favorite> {
    favorites::list()
}

#[tauri::command]
async fn fav_add(url: String) -> Result<Vec<favorites::Favorite>, String> {
    favorites::add(&url).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn fav_remove(id: String) -> Result<Vec<favorites::Favorite>, String> {
    favorites::remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn fav_done(id: String, done: bool) -> Result<Vec<favorites::Favorite>, String> {
    favorites::set_done(&id, done).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- découpe

/// Préréglages proposables pour la machine choisie.
#[tauri::command]
async fn slice_lists(machine: Option<String>) -> Result<slice::PresetLists, String> {
    slice::lists(machine.as_deref()).map_err(|e| e.to_string())
}

/// Valeurs de départ des réglages simplifiés pour un préréglage donné.
#[tauri::command]
async fn slice_defaults(machine: String, process: String) -> Result<slice::Simple, String> {
    slice::defaults(&machine, &process).map_err(|e| e.to_string())
}

/// Lance une découpe en tâche de fond ; l'avancement arrive par l'évènement
/// `slice-progress`.
#[tauri::command]
fn slice_start(app: tauri::AppHandle, request: slice::Request) -> Result<String, String> {
    slice::start(app, request).map_err(|e| e.to_string())
}

#[tauri::command]
fn slice_cancel(id: String) -> bool {
    slice::cancel(&id)
}

/// Trancheurs détectés sur la machine.
#[tauri::command]
fn slicers_list() -> Vec<slicers::Slicer> {
    slicers::list()
}

/// Ouvre les fichiers dans un trancheur ; `add` envoie une copie allégée de ses
/// réglages de projet, pour une simple pose sur le plateau courant.
#[tauri::command]
async fn open_in_slicer(paths: Vec<String>, app: Option<String>, add: bool) -> Result<(), String> {
    slicers::open_with(&paths, app.as_deref(), add).map_err(|e| e.to_string())
}

#[tauri::command]
fn quick_places() -> Vec<PlaceDto> {
    let mut v = Vec::new();
    let mut push = |label: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            if p.is_dir() {
                v.push(PlaceDto {
                    label: label.to_string(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    };
    push("Téléchargements", dirs::download_dir());
    push("Documents", dirs::document_dir());
    push("Bureau", dirs::desktop_dir());
    push("Dossier personnel", dirs::home_dir());
    v
}

// ---------------------------------------------------------------- imprimantes

#[tauri::command]
fn printers_list() -> Vec<printers::Printer> {
    printers::load()
}

/// Ajoute une imprimante, ou met a jour celle qui porte le meme identifiant.
#[tauri::command]
fn printer_save(mut printer: printers::Printer) -> Result<Vec<printers::Printer>, String> {
    let mut list = printers::load();
    if printer.id.is_empty() {
        printer.id = printers::new_id();
    }
    match list.iter_mut().find(|p| p.id == printer.id) {
        Some(slot) => *slot = printer,
        None => list.push(printer),
    }
    printers::save(&list).map_err(|e| e.to_string())?;
    Ok(list)
}

#[tauri::command]
fn printer_remove(id: String) -> Result<Vec<printers::Printer>, String> {
    let mut list = printers::load();
    list.retain(|p| p.id != id);
    printers::save(&list).map_err(|e| e.to_string())?;
    Ok(list)
}

/// Teste une adresse saisie par l'utilisateur (aucune exploration du reseau).
#[tauri::command]
async fn printer_probe(host: String, port: u16) -> printers::Probe {
    printers::probe(&host, port).await
}

#[tauri::command]
async fn printer_status(host: String, port: u16) -> printers::Status {
    printers::status(&host, port).await
}

/// Ouvre les flux temps reel (onglet Imprimantes affiche).
#[tauri::command]
fn printers_watch_start(app: tauri::AppHandle) {
    watch::start(app);
}

#[tauri::command]
fn printers_watch_stop() {
    watch::stop();
}

/// Dossier passe en argument au lancement : `snap-studio ~/Downloads`.
#[tauri::command]
fn initial_dir() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_dir())
}

#[tauri::command]
fn cache_info() -> CacheDto {
    CacheDto {
        bytes: thumbs::size_on_disk(),
    }
}

#[tauri::command]
fn clear_cache() -> usize {
    thumbs::clear()
}

// ---------------------------------------------------------------- protocole thumb://

type Job = Box<dyn FnOnce() + Send + 'static>;

fn pool() -> &'static Sender<Job> {
    static POOL: OnceLock<Sender<Job>> = OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        let rx = std::sync::Arc::new(Mutex::new(rx));
        let n = std::thread::available_parallelism()
            .map(|n| n.get().clamp(2, 8))
            .unwrap_or(4);
        for _ in 0..n {
            let rx = rx.clone();
            std::thread::spawn(move || loop {
                let job = { rx.lock().unwrap().recv() };
                match job {
                    Ok(job) => job(),
                    Err(_) => break,
                }
            });
        }
        tx
    })
}

fn query_param(uri: &str, key: &str) -> Option<String> {
    let q = uri.split_once('?')?.1;
    for kv in q.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            if k == key {
                return urlencoding::decode(v).ok().map(|s| s.to_string());
            }
        }
    }
    None
}

/// Vignette d'un favori, mise en cache au moment de l'ajout.
fn handle_favimg(uri: &str) -> Response<Vec<u8>> {
    let deny = || {
        Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    };
    let Some(name) = query_param(uri, "f") else {
        return deny();
    };
    // Le nom vient de notre propre magasin, mais on refuse tout chemin.
    if name.contains('/') || name.contains("..") {
        return deny();
    }
    match std::fs::read(favorites::images_dir().join(&name)) {
        Ok(bytes) => {
            let kind = if name.ends_with(".png") {
                "image/png"
            } else if name.ends_with(".webp") {
                "image/webp"
            } else if name.ends_with(".gif") {
                "image/gif"
            } else {
                "image/jpeg"
            };
            Response::builder()
                .status(200)
                .header("Content-Type", kind)
                .header("Cache-Control", "public, max-age=86400")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap()
        }
        Err(_) => deny(),
    }
}

/// Trajectoires d'un G-code pour le visualiseur.
fn handle_gcode(uri: &str) -> Response<Vec<u8>> {
    let fail = |code: u16, msg: &str| {
        Response::builder()
            .status(code)
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Error", msg.to_string())
            .body(Vec::new())
            .unwrap()
    };
    let Some(path) = query_param(uri, "p") else {
        return fail(400, "chemin manquant");
    };
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => return fail(404, &e.to_string()),
    };
    match gcode::parse(file) {
        Ok(d) => Response::builder()
            .status(200)
            .header("Content-Type", "application/octet-stream")
            .header("Cache-Control", "public, max-age=3600")
            .header("Access-Control-Allow-Origin", "*")
            .body(gcode::encode(&d))
            .unwrap(),
        Err(e) => fail(422, &e.to_string()),
    }
}

/// Maillage brut pour le visualiseur 3D.
/// Verse l'état courant dans les fichiers de l'utilisateur, en 3MF.
#[tauri::command]
fn ia_save(id: String) -> Result<String, String> {
    ia::save_to_files(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn ia_versions(id: String) -> Vec<ia::Version> {
    ia::versions(&id)
}

#[tauri::command]
fn ia_revert(id: String, n: u32) -> Result<(), String> {
    ia::revert(&id, n).map_err(|e| e.to_string())
}

#[tauri::command]
fn ia_stats(id: String) -> Result<mesh::Stats, String> {
    ia::current_stats(&id).map_err(|e| e.to_string())
}

/// Ouvre — ou rouvre — le terminal d'une conversation.
#[tauri::command]
fn pty_open(app: tauri::AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let c = ia::get(&id).map_err(|e| e.to_string())?;
    pty::open(&app, &c, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_write(id: String, data: String) -> Result<(), String> {
    pty::write(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_close(id: String) {
    pty::close(&id);
}

/// Vrai si Claude a une session enregistrée pour cette conversation.
#[tauri::command]
fn ia_resumable(id: String) -> bool {
    ia::has_session(&id)
}

/// Vrai si un terminal tourne déjà pour cette conversation.
#[tauri::command]
fn pty_running(id: String) -> bool {
    pty::is_open(&id)
}

/// Dossier de travail, pour l'ouvrir dans le Finder.
#[tauri::command]
fn ia_workspace(id: String) -> String {
    ia::workspace(&id).to_string_lossy().to_string()
}

#[tauri::command]
fn ia_get(id: String) -> Result<ia::Conversation, String> {
    ia::get(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- IA

#[tauri::command]
fn ia_engine() -> ia::Engine {
    ia::engine()
}

#[tauri::command]
fn ia_list() -> Vec<ia::Conversation> {
    ia::list()
}

#[tauri::command]
fn ia_create(
    source: String,
    prompt: String,
    engine: String,
) -> Result<ia::Conversation, String> {
    ia::create(Path::new(&source), &prompt, &engine).map_err(|e| e.to_string())
}

#[tauri::command]
fn ia_delete(id: String) -> Result<Vec<ia::Conversation>, String> {
    // Effacer le dossier sous les pieds d'un Claude en cours le laisserait
    // tourner sans répertoire : on ferme d'abord, on efface ensuite.
    pty::close(&id);
    ia::remove(&id).map_err(|e| e.to_string())?;
    Ok(ia::list())
}

/// Chemin du maillage courant et empreinte de sa dernière écriture.
#[tauri::command]
fn ia_current(id: String) -> Result<ia::CurrentDto, String> {
    ia::current_dto(&id).map_err(|_| "aucun objet dans cette conversation".to_string())
}

fn handle_mesh(uri: &str) -> Response<Vec<u8>> {
    let fail = |code: u16, msg: &str| {
        Response::builder()
            .status(code)
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Error", msg.to_string())
            .body(Vec::new())
            .unwrap()
    };
    let Some(path) = query_param(uri, "p") else {
        return fail(400, "chemin manquant");
    };
    // Au-delà, l'affichage devient lourd sans gagner en lisibilité : le
    // chargeur échantillonne alors les triangles.
    let budget: usize = query_param(uri, "b")
        .and_then(|s| s.parse().ok())
        .unwrap_or(900_000)
        .clamp(10_000, 3_000_000);

    // L'onglet IA travaille en STL ; le même protocole sert les deux formats,
    // l'extension suffit à trancher.
    let is_stl = Path::new(&path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("stl"));
    let loaded = if is_stl {
        stl::read(Path::new(&path)).map(|mut m| {
            mesh::downsample(&mut m, budget);
            m
        })
    } else {
        match model3mf::open(Path::new(&path)) {
            Ok(mut zip) => mesh::load_mesh(&mut zip, budget),
            Err(e) => return fail(404, &e.to_string()),
        }
    };
    match loaded {
        Ok(m) => Response::builder()
            .status(200)
            .header("Content-Type", "application/octet-stream")
            .header("Cache-Control", "public, max-age=3600")
            .header("Access-Control-Allow-Origin", "*")
            .body(mesh::encode(&m))
            .unwrap(),
        Err(e) => fail(422, &e.to_string()),
    }
}

fn handle_thumb(uri: &str) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    };
    let Some(path) = query_param(uri, "p") else {
        return not_found();
    };
    let size: u32 = query_param(uri, "s")
        .and_then(|s| s.parse().ok())
        .unwrap_or(320)
        .clamp(64, 1600);
    let pref = match query_param(uri, "k").as_deref() {
        Some("1") => ThumbPref::Plate,
        Some("2") => ThumbPref::Model,
        Some("3") => ThumbPref::Render,
        _ => ThumbPref::Auto,
    };
    match thumbs::get(Path::new(&path), size, pref) {
        Ok(t) => Response::builder()
            .status(200)
            .header("Content-Type", "image/png")
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .header("Access-Control-Allow-Origin", "*")
            .body(t.png)
            .unwrap(),
        Err(_) => not_found(),
    }
}

// ---------------------------------------------------------------- app

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Avant tout : reprise des données de l'ancienne « 3MF Studio ».
    migrate::run();
    std::thread::spawn(thumbs::prune_old);

    let builder = tauri::Builder::default();
    // Barre de menus native sur macOS ; ailleurs, l'interface garde ses raccourcis.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| menu::app_menu(app));
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("favimg", |_app, request: Request<Vec<u8>>, responder| {
            let uri = request.uri().to_string();
            let _ = pool().send(Box::new(move || {
                responder.respond(handle_favimg(&uri));
            }));
        })
        .register_asynchronous_uri_scheme_protocol("gcode", |_app, request: Request<Vec<u8>>, responder| {
            let uri = request.uri().to_string();
            let _ = pool().send(Box::new(move || {
                responder.respond(handle_gcode(&uri));
            }));
        })
        .register_asynchronous_uri_scheme_protocol("mesh", |_app, request: Request<Vec<u8>>, responder| {
            let uri = request.uri().to_string();
            let _ = pool().send(Box::new(move || {
                responder.respond(handle_mesh(&uri));
            }));
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |_app, request: Request<Vec<u8>>, responder| {
            let uri = request.uri().to_string();
            let _ = pool().send(Box::new(move || {
                responder.respond(handle_thumb(&uri));
            }));
        })
        .on_menu_event(|app, event| menu::forward(app, event.id().as_ref()))
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                // Fenêtre entière vibrante : le CSS rend opaque la zone de
                // contenu et laisse la barre latérale translucide.
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::FollowsWindowActiveState),
                        None,
                    );
                }
                // Créée invisible pour éviter le flash blanc avant le premier rendu.
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            scan_folder,
            read_metas,
            analyze,
            trash_files,
            reveal,
            open_file,
            quick_places,
            slicers_list,
            open_in_slicer,
            slice_lists,
            slice_defaults,
            slice_start,
            slice_cancel,
            lib_sites,
            lib_open,
            lib_close,
            lib_show,
            lib_rect,
            lib_navigate,
            lib_command,
            lib_url,
            lib_logout,
            ia_engine,
            ia_list,
            ia_create,
            ia_delete,
            ia_current,
            ia_get,
            ia_workspace,
            ia_save,
            ia_versions,
            ia_revert,
            ia_stats,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_running,
            ia_resumable,
            fav_list,
            fav_add,
            fav_remove,
            fav_done,
            initial_dir,
            printers_list,
            printer_save,
            printer_remove,
            printer_probe,
            printer_status,
            printers_watch_start,
            printers_watch_stop,
            cache_info,
            clear_cache,
            menu::popup_menu
        ])
        .build(tauri::generate_context!())
        .expect("erreur au demarrage de l'application")
        .run(|_app, event| {
            // Un terminal survivrait à la fenêtre : on le ferme avec elle.
            if let tauri::RunEvent::Exit = event {
                pty::close_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_query() {
        let u = "thumb://localhost/t?p=%2FUsers%2Fa%2FMon%20fichier%20%2B%20test.3mf&s=320&k=2&v=12";
        assert_eq!(
            query_param(u, "p").as_deref(),
            Some("/Users/a/Mon fichier + test.3mf")
        );
        assert_eq!(query_param(u, "s").as_deref(), Some("320"));
        assert_eq!(query_param(u, "k").as_deref(), Some("2"));
        assert_eq!(query_param(u, "zz"), None);
    }

    /// Affiche les metadonnees lues sur de vrais fichiers.
    #[test]
    fn dump_meta() {
        let dir = std::env::var("PROBE_DIR")
            .unwrap_or_else(|_| format!("{}/Downloads", std::env::var("HOME").unwrap()));
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e.eq_ignore_ascii_case("3mf")).unwrap_or(false))
            .collect();
        files.sort();
        for p in files.iter().take(6) {
            let m = meta_of(&p.to_string_lossy());
            println!(
                "{}\n  titre={:?}\n  createur={:?} licence={:?}\n  duree={:?}s poids={:?}g plateaux={} imprimante={:?}\n  pieces={:?}\n  filaments={:?}\n  vignette_integree={}",
                p.file_name().unwrap().to_string_lossy(),
                m.title, m.designer, m.license, m.print_time_s, m.weight_g, m.plates, m.printer,
                m.objects, m.filaments.iter().map(|f| format!("{} {:?} {:?}g", f.kind, f.color, f.used_g)).collect::<Vec<_>>(),
                m.has_embedded_thumb
            );
        }
    }
}
