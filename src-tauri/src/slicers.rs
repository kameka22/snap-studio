//! Envoi d'un fichier vers un trancheur installé.
//!
//! Deux gestes distincts :
//!
//! * **Ouvrir** passe le fichier tel quel. Sur un projet, le trancheur proposera
//!   de l'ouvrir comme projet et remplacera son plateau.
//! * **Ajouter au plateau** passe une copie allégée de ses réglages de projet
//!   (voir [`crate::write3mf::strip_project`]) : le trancheur l'importe alors
//!   comme simple géométrie, sans toucher à la session en cours.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Un trancheur reconnu et ses emplacements habituels, par système.
/// Chaque système ne lit que sa colonne.
#[allow(dead_code)]
struct Known {
    name: &'static str,
    /// macOS : paquets d'application, dans `/Applications` ou `~/Applications`.
    mac: &'static [&'static str],
    /// Windows : exécutables, relatifs à `Program Files` ou `%LOCALAPPDATA%\Programs`.
    win: &'static [&'static str],
    /// Linux : commandes du `PATH`, et début du nom de l'AppImage.
    linux: &'static [&'static str],
}

/// Trancheurs reconnus, dans l'ordre de préférence.
const KNOWN: &[Known] = &[
    Known {
        name: "Snapmaker Orca",
        mac: &["Snapmaker Orca.app"],
        win: &[r"Snapmaker_Orca\snapmaker-orca.exe", r"Snapmaker Orca\snapmaker-orca.exe"],
        linux: &["snapmaker-orca", "Snapmaker_Orca"],
    },
    Known {
        name: "OrcaSlicer",
        mac: &["OrcaSlicer.app"],
        win: &[r"OrcaSlicer\orca-slicer.exe"],
        linux: &["orca-slicer", "OrcaSlicer"],
    },
    Known {
        name: "Bambu Studio",
        mac: &["BambuStudio.app", "Bambu Studio.app"],
        win: &[r"Bambu Studio\bambu-studio.exe"],
        linux: &["bambu-studio", "BambuStudio", "Bambu_Studio"],
    },
    Known {
        name: "PrusaSlicer",
        mac: &["PrusaSlicer.app"],
        win: &[r"Prusa3D\PrusaSlicer\prusa-slicer.exe"],
        linux: &["prusa-slicer", "PrusaSlicer"],
    },
    Known {
        name: "SuperSlicer",
        mac: &["SuperSlicer.app"],
        win: &[r"SuperSlicer\superslicer.exe"],
        linux: &["superslicer", "SuperSlicer"],
    },
    Known {
        name: "UltiMaker Cura",
        mac: &["UltiMaker Cura.app", "Ultimaker Cura.app", "Cura.app"],
        win: &[],
        linux: &["cura", "UltiMaker-Cura"],
    },
    Known {
        name: "Creality Print",
        mac: &["Creality Print.app"],
        win: &[],
        linux: &["CrealityPrint"],
    },
    Known {
        name: "Snapmaker Luban",
        mac: &["Snapmaker Luban.app"],
        win: &[],
        linux: &[],
    },
];

#[derive(Serialize, Clone)]
pub struct Slicer {
    pub name: String,
    /// macOS : le paquet `.app` ; ailleurs : l'exécutable ou l'AppImage.
    pub path: String,
}

/// Emplacements candidats d'un trancheur sur ce système.
#[cfg(target_os = "macos")]
fn candidates(k: &Known) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    k.mac
        .iter()
        .flat_map(|b| roots.iter().map(move |r| r.join(b)))
        .filter(|p| p.is_dir())
        .collect()
}

#[cfg(windows)]
fn candidates(k: &Known) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
        .collect();
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.join("Programs"));
    }
    k.win
        .iter()
        .flat_map(|e| roots.iter().map(move |r| r.join(e)))
        .filter(|p| p.is_file())
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidates(k: &Known) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = k.linux.iter().filter_map(|c| crate::util::which(c)).collect();
    // AppImage déposée dans un dossier habituel : « Snapmaker_Orca_Linux_V2.4.0.AppImage ».
    let mut dirs_ = vec![PathBuf::from("/opt")];
    if let Some(h) = dirs::home_dir() {
        for d in ["Applications", "Downloads", "Téléchargements", ".local/bin", "bin"] {
            dirs_.push(h.join(d));
        }
    }
    for d in dirs_ {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            let hit = n.ends_with(".appimage")
                && k.linux.iter().any(|p| n.starts_with(&p.to_lowercase()));
            if hit && e.path().is_file() {
                out.push(e.path());
            }
        }
    }
    out
}

/// Trancheurs présents sur la machine.
pub fn list() -> Vec<Slicer> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for k in KNOWN {
        for p in candidates(k) {
            // Systèmes de fichiers insensibles à la casse (macOS, Windows) :
            // deux orthographes du même nom désignent la même application.
            let key = std::fs::canonicalize(&p)
                .map(|c| c.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| p.to_string_lossy().to_lowercase());
            if seen.insert(key) {
                out.push(Slicer {
                    name: k.name.to_string(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    out
}

/// Exécutable à lancer en ligne de commande pour un trancheur de [`list`].
pub fn executable(app: &Path) -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let macos = app.join("Contents/MacOS");
        for e in std::fs::read_dir(&macos)?.flatten() {
            let p = e.path();
            // L'exécutable principal porte le nom de l'application, les autres
            // binaires du paquet sont des utilitaires.
            if p.is_file() && p.file_name().map(|n| n != "crashpad_handler").unwrap_or(false) {
                return Ok(p);
            }
        }
        Err(anyhow!("exécutable introuvable dans {}", macos.display()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        if app.is_file() {
            Ok(app.to_path_buf())
        } else {
            Err(anyhow!("exécutable introuvable : {}", app.display()))
        }
    }
}

/// Dossier `resources` d'un trancheur (profils, images…).
pub fn resources(app: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let found = Some(app.join("Contents/Resources"));
    #[cfg(windows)]
    let found = app.parent().map(|d| d.join("resources"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let found = linux_resources(app);
    found.filter(|r| r.is_dir())
}

/// Linux : à côté de l'exécutable, dans une installation `share/`, ou à
/// l'intérieur de l'AppImage, extraite une fois dans le cache.
#[cfg(all(unix, not(target_os = "macos")))]
fn linux_resources(app: &Path) -> Option<PathBuf> {
    let is_appimage = app
        .extension()
        .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("appimage"));
    if is_appimage {
        return appimage_resources(app);
    }
    let real = std::fs::canonicalize(app).ok()?;
    let dir = real.parent()?;
    let mut cands = vec![dir.join("resources"), dir.join("../resources")];
    if let Ok(rd) = std::fs::read_dir(dir.join("../share")) {
        cands.extend(rd.flatten().map(|e| e.path()));
    }
    cands.into_iter().find(|c| c.join("profiles").is_dir())
}

/// Extrait les profils de l'AppImage dans le cache, une fois par version du
/// fichier (taille et date), et rend le dossier `resources` obtenu.
#[cfg(all(unix, not(target_os = "macos")))]
fn appimage_resources(app: &Path) -> Option<PathBuf> {
    let meta = std::fs::metadata(app).ok()?;
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = crate::util::fnv1a(&[format!("{}|{}|{}", app.display(), meta.len(), stamp).as_bytes()]);
    let root = dirs::cache_dir()?
        .join("fr.carlini.snapstudio")
        .join("engine")
        .join(format!("{key:016x}"));
    let res = root.join("squashfs-root/resources");
    if res.join("profiles").is_dir() {
        return Some(res);
    }
    let _ = std::fs::create_dir_all(&root);
    // Les profils seulement, sinon tout le contenu.
    for pattern in [Some("resources/profiles/*"), None] {
        let mut cmd = std::process::Command::new(app);
        cmd.arg("--appimage-extract").current_dir(&root);
        if let Some(p) = pattern {
            cmd.arg(p);
        }
        let ok = cmd
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if ok && res.join("profiles").is_dir() {
            return Some(res);
        }
    }
    None
}

/// Dossier des copies allégées, vidé des fichiers de la veille.
fn plate_dir() -> PathBuf {
    let dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio")
        .join("plate");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
        for e in rd.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t < cutoff)
                .unwrap_or(false);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    dir
}

/// Prépare le fichier à transmettre : tel quel, ou allégé pour un ajout.
fn prepare(path: &Path, add: bool) -> Result<PathBuf> {
    if !add || crate::scan::kind_of(path) != Some("3mf") {
        return Ok(path.to_path_buf());
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "objet".into());
    let dst = plate_dir().join(format!("{stem}.3mf"));
    match crate::write3mf::strip_project(path, &dst) {
        Ok(n) => {
            log(&format!("{stem} : {n} entrées de projet écartées"));
            Ok(dst)
        }
        // Un fichier illisible part tel quel : le trancheur dira mieux que nous
        // ce qui ne va pas.
        Err(e) => {
            log(&format!("allègement impossible ({e}), envoi tel quel"));
            Ok(path.to_path_buf())
        }
    }
}

fn log(msg: &str) {
    eprintln!("[slicers] {msg}");
}

/// Ouvre les fichiers dans le trancheur demandé, ou dans l'application par
/// défaut du système si aucun n'est précisé.
pub fn open_with(paths: &[String], app: Option<&str>, add: bool) -> Result<()> {
    if paths.is_empty() {
        return Err(anyhow!("aucun fichier"));
    }
    let mut files = Vec::new();
    for p in paths {
        files.push(prepare(Path::new(p), add)?);
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if let Some(app) = app.filter(|a| !a.is_empty()) {
            if !Path::new(app).exists() {
                return Err(anyhow!("application introuvable : {app}"));
            }
            cmd.arg("-a").arg(app);
        }
        // Un seul appel pour tous les fichiers : macOS les transmet ensemble à
        // l'instance déjà lancée, ce qui les pose sur le même plateau.
        cmd.args(&files);
        let status = cmd.status()?;
        if !status.success() {
            return Err(anyhow!("l'ouverture a échoué (code {:?})", status.code()));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        match app.filter(|a| !a.is_empty()) {
            Some(app) => {
                let exe = executable(Path::new(app))?;
                let mut cmd = std::process::Command::new(exe);
                crate::util::no_window(&mut cmd);
                cmd.args(&files).spawn()?;
            }
            // Application par défaut du système, fichier par fichier.
            None => {
                for f in &files {
                    #[cfg(windows)]
                    let mut cmd = {
                        let mut c = std::process::Command::new("cmd");
                        c.args(["/C", "start", ""]).arg(f);
                        c
                    };
                    #[cfg(not(windows))]
                    let mut cmd = {
                        let mut c = std::process::Command::new("xdg-open");
                        c.arg(f);
                        c
                    };
                    crate::util::no_window(&mut cmd);
                    cmd.spawn()?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_installed_slicers() {
        let l = list();
        for s in &l {
            println!("{} — {}", s.name, s.path);
            assert!(Path::new(&s.path).exists());
        }
        // Rien d'installé sur une machine de compilation : on vérifie seulement
        // la cohérence, pas la présence.
        assert!(l.iter().all(|s| KNOWN.iter().any(|k| k.name == s.name)));
    }

    /// Un projet doit produire une copie allégée dans le dossier de travail.
    #[test]
    fn prepare_strips_a_project() {
        let Ok(src) = std::env::var("PREPARE_SRC") else {
            return;
        };
        let out = prepare(Path::new(&src), true).unwrap();
        assert_ne!(out, Path::new(&src), "une copie a été faite");
        assert!(out.starts_with(plate_dir()), "déposée dans le dossier de travail");
        let z = crate::model3mf::open(&out).unwrap();
        let names = crate::model3mf::entry_names(&z);
        assert!(!names.iter().any(|n| n.to_ascii_lowercase().contains("project_settings")));
        assert!(names.iter().any(|n| n == "3D/3dmodel.model"), "la géométrie est là");
        println!("{} → {} ({} entrées)", src, out.display(), names.len());
    }

    #[test]
    fn prepare_passes_gcode_through() {
        let p = Path::new("/tmp/inexistant.gcode");
        assert_eq!(prepare(p, true).unwrap(), p, "un G-code n'est pas allégé");
    }
}
