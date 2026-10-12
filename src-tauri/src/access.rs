//! Premier accès à un dossier, une seule fois et un seul fil à la fois.
//!
//! macOS protège Téléchargements, Documents, Bureau… : le premier accès de
//! l'application déclenche une demande d'autorisation. Tant que l'utilisateur
//! n'a pas répondu, chaque fil qui touche au dossier peut déclencher la sienne
//! — or l'ouverture d'un dossier lance en parallèle le scan, la lecture des
//! métadonnées et les vignettes. Ici, les premiers accès passent un par un par
//! une porte : les autres fils attendent la réponse au lieu de redemander.
//! Un dossier déjà ouvert ne passe plus par la porte : une demande en attente
//! ne bloque pas les dossiers déjà autorisés.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};

fn seen() -> &'static RwLock<HashSet<PathBuf>> {
    static SEEN: OnceLock<RwLock<HashSet<PathBuf>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

/// Porte des premiers accès, tenue pendant l'éventuelle demande.
fn gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(Default::default)
}

fn known(dir: &Path) -> bool {
    seen().read().unwrap_or_else(|e| e.into_inner()).contains(dir)
}

/// Ouvre le dossier une première fois.
pub fn ensure_dir(dir: &Path) {
    if !cfg!(target_os = "macos") || known(dir) {
        return;
    }
    let _g = gate().lock().unwrap_or_else(|e| e.into_inner());
    // Un autre fil a pu passer la porte pendant l'attente.
    if known(dir) {
        return;
    }
    let _ = std::fs::read_dir(dir).map(|mut rd| rd.next());
    seen().write().unwrap_or_else(|e| e.into_inner()).insert(dir.to_path_buf());
}

/// Même chose pour le dossier d'un fichier.
pub fn ensure_file(file: &Path) {
    if let Some(dir) = file.parent() {
        ensure_dir(dir);
    }
}
