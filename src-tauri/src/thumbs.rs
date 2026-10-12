//! Generation et cache disque des vignettes.

use crate::model3mf::{self, ThumbPref, ThumbSource};
use crate::util::fnv1a;
use anyhow::{anyhow, Result};
use image::imageops::FilterType;
use image::GenericImageView;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CACHE_VERSION: u8 = 3;
const MAGIC: &[u8; 4] = b"3MFT";
/// Budget de triangles pour le rendu de secours.
const TRI_BUDGET: usize = 1_800_000;

pub struct Thumb {
    pub png: Vec<u8>,
    pub source: ThumbSource,
}

pub fn cache_dir() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("fr.carlini.snapstudio").join("thumbs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn src_tag(s: ThumbSource) -> u8 {
    match s {
        ThumbSource::Plate => 1,
        ThumbSource::Model => 2,
        ThumbSource::Rendered => 3,
        ThumbSource::None => 4,
    }
}
fn tag_src(t: u8) -> ThumbSource {
    match t {
        1 => ThumbSource::Plate,
        2 => ThumbSource::Model,
        3 => ThumbSource::Rendered,
        _ => ThumbSource::None,
    }
}

fn cache_key(path: &Path, size: u32, pref: ThumbPref) -> PathBuf {
    let md = std::fs::metadata(path).ok();
    let mtime = md
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let len = md.as_ref().map(|m| m.len()).unwrap_or(0);
    let h = fnv1a(&[
        path.to_string_lossy().as_bytes(),
        &mtime.to_le_bytes(),
        &len.to_le_bytes(),
        &size.to_le_bytes(),
        &[pref.tag(), CACHE_VERSION],
    ]);
    cache_dir().join(format!("{:016x}.thumb", h))
}

fn read_cache(file: &Path) -> Option<Thumb> {
    let data = std::fs::read(file).ok()?;
    if data.len() < 8 || &data[0..4] != MAGIC || data[4] != CACHE_VERSION {
        return None;
    }
    Some(Thumb {
        source: tag_src(data[5]),
        png: data[8..].to_vec(),
    })
}

fn write_cache(file: &Path, thumb: &Thumb) {
    let mut out = Vec::with_capacity(thumb.png.len() + 8);
    out.extend_from_slice(MAGIC);
    out.push(CACHE_VERSION);
    out.push(src_tag(thumb.source));
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&thumb.png);
    let tmp = file.with_extension("tmp");
    if std::fs::write(&tmp, &out).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

/// Limite le nombre de rendus geometriques simultanes (gros pics memoire).
fn render_slot() -> &'static (Mutex<usize>, Condvar) {
    static SLOT: OnceLock<(Mutex<usize>, Condvar)> = OnceLock::new();
    SLOT.get_or_init(|| {
        let max = std::thread::available_parallelism()
            .map(|n| (n.get() / 2).max(2))
            .unwrap_or(2);
        (Mutex::new(max), Condvar::new())
    })
}

struct RenderGuard;
impl RenderGuard {
    fn acquire() -> RenderGuard {
        let (lock, cv) = render_slot();
        let mut n = lock.lock().unwrap();
        while *n == 0 {
            n = cv.wait(n).unwrap();
        }
        *n -= 1;
        RenderGuard
    }
}
impl Drop for RenderGuard {
    fn drop(&mut self) {
        let (lock, cv) = render_slot();
        *lock.lock().unwrap() += 1;
        cv.notify_one();
    }
}

/// Retire les marges entierement transparentes (les apercus de slicer en ont beaucoup).
fn trim_alpha(img: image::DynamicImage) -> image::DynamicImage {
    if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
        for (x, y, p) in rgba.enumerate_pixels() {
            if p.0[3] > 8 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
        if x1 > x0 && y1 > y0 {
            let pad = ((x1 - x0).max(y1 - y0) / 24).max(2);
            let nx0 = x0.saturating_sub(pad);
            let ny0 = y0.saturating_sub(pad);
            let nx1 = (x1 + pad).min(w - 1);
            let ny1 = (y1 + pad).min(h - 1);
            return img.crop_imm(nx0, ny0, nx1 - nx0 + 1, ny1 - ny0 + 1);
        }
    }
    img
}

fn to_png(img: &image::DynamicImage) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)?;
    Ok(buf)
}

/// Aperçu d'un G-code : vignette intégrée par le trancheur si elle existe,
/// sinon rendu des trajectoires.
fn generate_gcode(path: &Path, size: u32) -> Result<Thumb> {
    if let Ok(f) = std::fs::File::open(path) {
        if let Some(bytes) = crate::gcode::embedded_thumbnail(f) {
            if let Ok(img) = image::load_from_memory(&bytes) {
                let img = trim_alpha(img);
                let (w, h) = img.dimensions();
                let img = if w > size || h > size {
                    img.resize(size, size, FilterType::Lanczos3)
                } else {
                    img
                };
                return Ok(Thumb {
                    png: to_png(&img)?,
                    source: ThumbSource::Plate,
                });
            }
        }
    }
    let _guard = RenderGuard::acquire();
    let data = crate::gcode::parse(std::fs::File::open(path)?)?;
    let img = crate::render::render_paths(&data.segs, data.min, data.max, size);
    Ok(Thumb {
        png: to_png(&image::DynamicImage::ImageRgba8(img))?,
        source: ThumbSource::Rendered,
    })
}

fn generate(path: &Path, size: u32, pref: ThumbPref) -> Result<Thumb> {
    if crate::scan::kind_of(path) == Some("gcode") {
        return generate_gcode(path, size);
    }
    let mut zip = model3mf::open(path)?;

    if pref != ThumbPref::Render {
        if let Some((_name, bytes, src)) = model3mf::find_thumbnail(&mut zip, pref) {
            if let Ok(img) = image::load_from_memory(&bytes) {
                let img = trim_alpha(img);
                let (w, h) = img.dimensions();
                let img = if w > size || h > size {
                    img.resize(size, size, FilterType::Lanczos3)
                } else {
                    img
                };
                return Ok(Thumb {
                    png: to_png(&img)?,
                    source: src,
                });
            }
        }
    }

    let _guard = RenderGuard::acquire();
    let mesh = crate::mesh::load_mesh(&mut zip, TRI_BUDGET)?;
    let img = crate::render::render(&mesh, size);
    Ok(Thumb {
        png: to_png(&image::DynamicImage::ImageRgba8(img))?,
        source: ThumbSource::Rendered,
    })
}

/// Vignette d'un fichier : cache disque, sinon generation.
pub fn get(path: &Path, size: u32, pref: ThumbPref) -> Result<Thumb> {
    crate::access::ensure_file(path);
    let key = cache_key(path, size, pref);
    if let Some(t) = read_cache(&key) {
        if t.source == ThumbSource::None {
            return Err(anyhow!("aucun apercu disponible"));
        }
        return Ok(t);
    }
    match generate(path, size, pref) {
        Ok(t) => {
            write_cache(&key, &t);
            Ok(t)
        }
        Err(e) => {
            // Echec memorise : evite de re-analyser un gros fichier a chaque affichage.
            write_cache(
                &key,
                &Thumb {
                    png: Vec::new(),
                    source: ThumbSource::None,
                },
            );
            Err(e)
        }
    }
}

pub fn clear() -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(cache_dir()) {
        for e in rd.flatten() {
            if std::fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

pub fn size_on_disk() -> u64 {
    std::fs::read_dir(cache_dir())
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

/// Menage : supprime les vignettes inutilisees depuis 60 jours.
pub fn prune_old() {
    let cutoff = SystemTime::now() - Duration::from_secs(60 * 24 * 3600);
    if let Ok(rd) = std::fs::read_dir(cache_dir()) {
        for e in rd.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.accessed().or_else(|_| m.modified()))
                .map(|t| t < cutoff)
                .unwrap_or(false);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Genere des vignettes sur des fichiers reels et mesure le temps.
    #[test]
    fn probe() {
        let dir = std::env::var("PROBE_DIR").unwrap_or_else(|_| {
            format!("{}/Downloads", std::env::var("HOME").unwrap())
        });
        let out = std::path::PathBuf::from(
            std::env::var("PROBE_OUT").unwrap_or_else(|_| "/tmp/probe".into()),
        );
        std::fs::create_dir_all(&out).unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .map(|e| e.eq_ignore_ascii_case("3mf"))
                    .unwrap_or(false)
            })
            .collect();
        files.sort();
        let limit: usize = std::env::var("PROBE_N")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(12);
        for p in files.iter().take(limit) {
            let t = Instant::now();
            match generate(p, 512, ThumbPref::Auto) {
                Ok(th) => {
                    let name = format!(
                        "{}-{:?}.png",
                        p.file_stem().unwrap().to_string_lossy(),
                        th.source
                    );
                    std::fs::write(out.join(&name), &th.png).unwrap();
                    println!("{:>7.0} ms  {:?}  {}", t.elapsed().as_secs_f32() * 1000.0, th.source, name);
                }
                Err(e) => println!("{:>7.0} ms  ECHEC {} : {}", t.elapsed().as_secs_f32() * 1000.0, p.display(), e),
            }
        }
    }
}
