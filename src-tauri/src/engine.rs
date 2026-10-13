//! Moteur de découpe embarqué : Snapmaker Orca allégé, téléchargé au premier
//! besoin.
//!
//! `engine.json` (embarqué à la compilation, mis à jour par
//! `scripts/engine.sh`) donne, pour chaque plateforme, l'adresse de l'archive
//! préparée par la CI « Moteur », sa taille et son empreinte SHA-256. Le
//! moteur est installé dans `<données>/engine/orca-<version>/` : téléchargement
//! en flux, empreinte vérifiée, décompression dans un dossier temporaire puis
//! renommage — un moteur à moitié installé n'est jamais utilisé.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

/// Message reconnu par l'interface : il propose alors le téléchargement.
pub const MISSING: &str = "moteur de découpe non installé";
/// Fichier témoin d'une installation complète.
const COMPLETE: &str = ".complete";

#[derive(Deserialize, Clone, Debug)]
pub struct Asset {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    /// Place occupée une fois décompressé.
    pub unpacked: u64,
    /// Point d'entrée : `.app`, exécutable ou `AppRun`.
    pub entry: String,
}

#[derive(Deserialize, Debug)]
struct Manifest {
    #[serde(default)]
    version: String,
    /// Code source exact du moteur (licence AGPL).
    #[serde(default)]
    source: String,
    #[serde(default)]
    platforms: HashMap<String, Asset>,
}

fn manifest() -> &'static Manifest {
    static M: OnceLock<Manifest> = OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str(include_str!("../engine.json")).unwrap_or(Manifest {
            version: String::new(),
            source: String::new(),
            platforms: HashMap::new(),
        })
    })
}

/// Clé de la plateforme courante dans le manifeste.
fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn asset() -> Option<&'static Asset> {
    manifest().platforms.get(&platform_key())
}

/// Vrai quand un moteur est référencé : sans lui (version de
/// développement), la découpe reste sur Snapmaker Orca installé.
pub fn referenced() -> bool {
    !manifest().version.is_empty() && !manifest().platforms.is_empty()
}

fn root() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio")
        .join("engine")
}

fn install_dir() -> PathBuf {
    root().join(format!("orca-{}", manifest().version))
}

/// Point d'entrée du moteur installé, s'il l'est entièrement.
pub fn installed() -> Option<PathBuf> {
    let a = asset()?;
    let dir = install_dir();
    let entry = dir.join(&a.entry);
    (dir.join(COMPLETE).is_file() && entry.exists()).then_some(entry)
}

/// Version d'un moteur installé auparavant (avant une mise à jour de Snap
/// Studio qui en référence un autre).
fn previous() -> Option<String> {
    let current = format!("orca-{}", manifest().version);
    std::fs::read_dir(root())
        .ok()?
        .flatten()
        .filter(|e| e.path().join(COMPLETE).is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("orca-") && *n != current)
        .map(|n| n.trim_start_matches("orca-").to_string())
        .max()
}

#[derive(Serialize, Clone)]
pub struct Status {
    pub version: String,
    /// Un moteur est référencé (sinon : Snapmaker Orca installé sert de repli).
    pub referenced: bool,
    pub source: String,
    /// Un moteur existe pour cette plateforme.
    pub available: bool,
    pub installed: bool,
    /// Moteur d'une version précédente encore présent : le nouveau est une
    /// mise à jour.
    pub previous: Option<String>,
    pub installing: bool,
    pub path: Option<String>,
    pub download_size: u64,
    pub disk_size: u64,
}

pub fn status() -> Status {
    let a = asset();
    let path = installed();
    Status {
        version: manifest().version.clone(),
        referenced: referenced(),
        source: manifest().source.clone(),
        available: a.is_some(),
        installed: path.is_some(),
        previous: if path.is_some() { None } else { previous() },
        installing: BUSY.load(Ordering::Relaxed),
        path: path.map(|p| p.to_string_lossy().to_string()),
        download_size: a.map(|a| a.size).unwrap_or(0),
        disk_size: a.map(|a| a.unpacked).unwrap_or(0),
    }
}

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct Progress {
    /// download | verify | extract | done
    phase: &'static str,
    done: u64,
    total: u64,
}

fn emit(app: &AppHandle, phase: &'static str, done: u64, total: u64) {
    let _ = app.emit("engine-progress", Progress { phase, done, total });
}

pub fn cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Télécharge, vérifie et installe le moteur de la plateforme.
pub async fn install(app: AppHandle) -> Result<Status> {
    let a = asset().ok_or_else(|| anyhow!("aucun moteur de découpe pour cette plateforme ({})", platform_key()))?;
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(anyhow!("installation déjà en cours"));
    }
    CANCEL.store(false, Ordering::Relaxed);
    let res = install_inner(&app, a).await;
    BUSY.store(false, Ordering::SeqCst);
    res.map(|_| status())
}

async fn install_inner(app: &AppHandle, a: &Asset) -> Result<()> {
    use futures_util::StreamExt;
    let root = root();
    std::fs::create_dir_all(&root)?;
    let part = root.join(format!(".download-{}.part", manifest().version));

    // Téléchargement en flux, empreinte calculée au passage.
    let resp = reqwest::Client::builder()
        .user_agent("Snap-Studio")
        .build()?
        .get(&a.url)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(anyhow!("téléchargement refusé : {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(a.size);
    let mut file = std::fs::File::create(&part)?;
    let mut hash = Sha256::new();
    let mut done = 0u64;
    let mut last = 0u64;
    let mut stream = resp.bytes_stream();
    emit(app, "download", 0, total);
    while let Some(chunk) = stream.next().await {
        if CANCEL.load(Ordering::Relaxed) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err(anyhow!("téléchargement annulé"));
        }
        let chunk = chunk?;
        file.write_all(&chunk)?;
        hash.update(&chunk);
        done += chunk.len() as u64;
        // Une mise à jour par demi-mégaoctet suffit à la barre.
        if done - last > 512 * 1024 || done == total {
            emit(app, "download", done, total);
            last = done;
        }
    }
    file.flush()?;
    drop(file);

    emit(app, "verify", done, total);
    let got = hex(&hash.finalize());
    if !got.eq_ignore_ascii_case(&a.sha256) {
        let _ = std::fs::remove_file(&part);
        return Err(anyhow!("empreinte invalide : fichier corrompu ou modifié"));
    }

    // Décompression hors du fil asynchrone, dans un dossier temporaire.
    emit(app, "extract", 0, a.unpacked);
    let staging = root.join(format!(".staging-{}", manifest().version));
    let target = install_dir();
    let part2 = part.clone();
    let staging2 = staging.clone();
    tauri::async_runtime::spawn_blocking(move || extract(&part2, &staging2))
        .await
        .map_err(|e| anyhow!("{e}"))??;
    std::fs::write(staging.join(COMPLETE), manifest().version.as_bytes())?;
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&staging, &target)?;
    let _ = std::fs::remove_file(&part);
    prune_old(&root, &target);
    emit(app, "done", a.unpacked, a.unpacked);
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Archive tar.zst → dossier ; droits d'exécution et liens conservés.
fn extract(archive: &Path, dst: &Path) -> Result<()> {
    if dst.exists() {
        std::fs::remove_dir_all(dst)?;
    }
    std::fs::create_dir_all(dst)?;
    let f = std::io::BufReader::new(std::fs::File::open(archive)?);
    let zst = ruzstd::decoding::StreamingDecoder::new(f).map_err(|e| anyhow!("archive illisible : {e}"))?;
    let mut tar = tar::Archive::new(zst);
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);
    tar.unpack(dst).map_err(|e| anyhow!("décompression impossible : {e}"))?;
    Ok(())
}

/// Les autres versions du moteur et les restes d'une installation
/// interrompue disparaissent ; les données du moteur restent.
fn prune_old(root: &Path, keep: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if p == keep || name == "data" {
            continue;
        }
        if name.starts_with("orca-") || name.starts_with(".staging-") {
            let _ = std::fs::remove_dir_all(&p);
        } else if name.starts_with(".download-") {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Supprime le moteur installé (les réglages et données de Snap Studio restent).
pub fn remove() -> Result<Status> {
    if BUSY.load(Ordering::Relaxed) {
        return Err(anyhow!("installation en cours"));
    }
    let dir = install_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(status())
}

/// Lecture d'une archive en mémoire : sert aux tests.
#[cfg(test)]
fn read_all(r: &mut impl std::io::Read) -> Vec<u8> {
    let mut v = Vec::new();
    r.read_to_end(&mut v).unwrap();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_manifest_is_not_referenced() {
        // Le dépôt part d'un manifeste vide : la découpe reste sur Orca installé.
        if manifest().version.is_empty() {
            assert!(!referenced());
            assert!(installed().is_none());
        }
        assert!(platform_key().contains('-'));
    }

    #[test]
    fn extracts_a_tar_zst_with_permissions() {
        let tmp = std::env::temp_dir().join("snapstudio-engine-extract");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src/bin")).unwrap();
        std::fs::write(tmp.join("src/bin/tool"), b"#!/bin/sh\necho ok\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(tmp.join("src/bin/tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // tar, puis zstd (compresseur de ruzstd).
        let mut tarball = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tarball);
            b.append_dir_all(".", tmp.join("src")).unwrap();
            b.finish().unwrap();
        }
        let zst = ruzstd::encoding::compress_to_vec(&tarball[..], ruzstd::encoding::CompressionLevel::Fastest);
        let archive = tmp.join("e.tar.zst");
        std::fs::write(&archive, &zst).unwrap();
        extract(&archive, &tmp.join("out")).unwrap();
        let mut f = std::fs::File::open(tmp.join("out/bin/tool")).unwrap();
        assert_eq!(read_all(&mut f), b"#!/bin/sh\necho ok\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tmp.join("out/bin/tool")).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "exécutable conservé");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
