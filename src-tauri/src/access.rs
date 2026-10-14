//! First access to a folder, once, and one thread at a time.
//!
//! macOS protects Downloads, Documents, Desktop…: the app's first access
//! triggers a permission prompt. Until the user answers, every thread that
//! touches the folder may trigger its own — and opening a folder starts the
//! scan, the metadata reading and the thumbnails in parallel. Here, first
//! accesses go one by one through a gate: the other threads wait for the
//! answer instead of asking again. A folder already opened no longer goes
//! through the gate: a pending prompt does not block folders already allowed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};

fn seen() -> &'static RwLock<HashSet<PathBuf>> {
    static SEEN: OnceLock<RwLock<HashSet<PathBuf>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

/// Gate for first accesses, held during the possible prompt.
fn gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(Default::default)
}

fn known(dir: &Path) -> bool {
    seen().read().unwrap_or_else(|e| e.into_inner()).contains(dir)
}

/// Opens the folder a first time.
pub fn ensure_dir(dir: &Path) {
    if !cfg!(target_os = "macos") || known(dir) {
        return;
    }
    let _g = gate().lock().unwrap_or_else(|e| e.into_inner());
    // Another thread may have gone through the gate while we waited.
    if known(dir) {
        return;
    }
    let _ = std::fs::read_dir(dir).map(|mut rd| rd.next());
    seen().write().unwrap_or_else(|e| e.into_inner()).insert(dir.to_path_buf());
}

/// Same for a file's folder.
pub fn ensure_file(file: &Path) {
    if let Some(dir) = file.parent() {
        ensure_dir(dir);
    }
}
