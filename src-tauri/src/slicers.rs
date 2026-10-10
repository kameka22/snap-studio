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

/// Applications reconnues, dans l'ordre de préférence.
const KNOWN: &[&str] = &[
    "Snapmaker Orca.app",
    "OrcaSlicer.app",
    "BambuStudio.app",
    "Bambu Studio.app",
    "PrusaSlicer.app",
    "SuperSlicer.app",
    "UltiMaker Cura.app",
    "Ultimaker Cura.app",
    "Cura.app",
    "Creality Print.app",
    "Snapmaker Luban.app",
];

#[derive(Serialize, Clone)]
pub struct Slicer {
    pub name: String,
    pub path: String,
}

/// Trancheurs présents sur la machine.
pub fn list() -> Vec<Slicer> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for known in KNOWN {
        for root in &roots {
            let p = root.join(known);
            if !p.is_dir() {
                continue;
            }
            // Le système de fichiers est insensible à la casse : deux
            // orthographes du même nom désignent la même application.
            let key = std::fs::canonicalize(&p)
                .map(|c| c.to_string_lossy().to_lowercase())
                .unwrap_or_else(|_| p.to_string_lossy().to_lowercase());
            if seen.insert(key) {
                out.push(Slicer {
                    name: known.trim_end_matches(".app").to_string(),
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }
    out
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
            assert!(Path::new(&s.path).is_dir());
        }
        // Rien d'installé sur une machine de compilation : on vérifie seulement
        // la cohérence, pas la présence.
        assert!(l.len() <= KNOWN.len());
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
