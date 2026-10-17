//! Plate of the "Prepare" view: the files' objects, each one's mesh, and
//! the scene written for slicing.
//!
//! A plate object is an occurrence of a file's `<build>`, isolated in its own
//! frame (centered on its bounding box, oriented as in the file). Its
//! placement on the plate fits in three values:
//!
//! 1. `scale`: scale per axis;
//! 2. `rot`: rotations in degrees around X, then Y, then Z;
//! 3. `pos`: (X, Y) position of the center; the object rests on the plate,
//!    its lowest point at Z = 0.
//!
//! The UI applies exactly the same rule for display.

use crate::mesh::{MeshData, Tri};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Beyond this, the bundled slicing gives up (as for a single file).
const FULL_BUDGET: usize = 8_000_000;

/// An object offered to the plate.
#[derive(Serialize, Clone, Debug)]
pub struct PlateItem {
    /// Rank of the occurrence in the file's `<build>`.
    pub index: usize,
    pub name: String,
    /// Center of the object in the file's scene (mm): the plates of a
    /// multi-plate 3MF keep their offset there.
    pub center: [f32; 3],
    /// Bounding box dimensions, file orientation.
    pub size: [f32; 3],
    pub triangles: usize,
    /// Original plate in the file (1 by default).
    pub plate: u32,
    /// Model extruders used by the object (from 1).
    pub extruders: Vec<u8>,
}

fn is_stl(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("stl"))
}

/// Mesh of an object, centered; also returns its center in the file.
pub fn load(path: &Path, index: usize, budget: usize) -> Result<(MeshData, [f32; 3])> {
    if is_stl(path) {
        if index != 0 {
            return Err(anyhow!("an STL holds a single object"));
        }
        let mut m = crate::stl::read(path)?;
        crate::mesh::downsample(&mut m, budget);
        let c = [
            (m.min[0] + m.max[0]) / 2.0,
            (m.min[1] + m.max[1]) / 2.0,
            (m.min[2] + m.max[2]) / 2.0,
        ];
        for t in &mut m.tris {
            for v in &mut t.v {
                for k in 0..3 {
                    v[k] -= c[k];
                }
            }
        }
        for k in 0..3 {
            m.min[k] -= c[k];
            m.max[k] -= c[k];
        }
        return Ok((m, c));
    }
    let mut zip = crate::model3mf::open(path)?;
    let it = crate::mesh::load_item(&mut zip, index, budget)?;
    Ok((it.mesh, it.center))
}

/// A file's objects, ready to put on the plate.
pub fn items(path: &Path) -> Result<Vec<PlateItem>> {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "object".into());
    if is_stl(path) {
        let (m, c) = load(path, 0, FULL_BUDGET)?;
        return Ok(vec![PlateItem {
            index: 0,
            name: stem,
            center: c,
            size: size_of(&m),
            triangles: m.tris.len(),
            plate: 1,
            extruders: vec![1],
        }]);
    }
    let mut zip = crate::model3mf::open(path)?;
    let build = crate::mesh::build_items(&mut zip)?;
    let (names, plates) = crate::model3mf::object_settings(&mut zip);
    let many = build.len() > 1;
    let mut out = Vec::with_capacity(build.len());
    for (i, b) in build.iter().enumerate() {
        let it = crate::mesh::load_item(&mut zip, i, FULL_BUDGET)?;
        let mut extruders = crate::mesh::colors_used(&it.mesh);
        if extruders.is_empty() {
            extruders.push(1);
        }
        out.push(PlateItem {
            index: i,
            name: names
                .get(&b.objid)
                .cloned()
                .unwrap_or_else(|| if many { format!("{stem} {}", i + 1) } else { stem.clone() }),
            center: it.center,
            size: size_of(&it.mesh),
            triangles: it.mesh.tris.len(),
            plate: plates.get(&b.objid).copied().unwrap_or(1),
            extruders,
        });
    }
    Ok(out)
}

fn size_of(m: &MeshData) -> [f32; 3] {
    [m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]]
}

/// Display mesh of an object. Triangles without their own color take the
/// filament color the project associates with their extruder.
pub fn display_mesh(path: &Path, index: usize, budget: usize) -> Result<MeshData> {
    let (mut m, _) = load(path, index, budget)?;
    if !is_stl(path) && m.extruders.len() == m.tris.len() {
        let mut zip = crate::model3mf::open(path)?;
        let colors: Vec<Option<[u8; 3]>> = crate::model3mf::project_filaments(&mut zip)
            .iter()
            .map(|f| f.color.as_deref().and_then(hex_rgb))
            .collect();
        for (t, e) in m.tris.iter_mut().zip(&m.extruders) {
            if t.c == crate::render::DEFAULT_COLOR {
                if let Some(Some(c)) = colors.get(e.saturating_sub(1) as usize) {
                    t.c = *c;
                }
            }
        }
    }
    Ok(m)
}

pub fn hex_rgb(s: &str) -> Option<[u8; 3]> {
    let h = s.trim_start_matches('#');
    if h.len() < 6 {
        return None;
    }
    let n = u32::from_str_radix(&h[..6], 16).ok()?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

// ------------------------------------------------------------ scene to slice

/// An object resting on the plate, as the UI describes it.
#[derive(Deserialize, Clone, Debug)]
pub struct SceneItem {
    pub path: String,
    pub item: usize,
    #[serde(default)]
    pub name: String,
    pub pos: [f32; 2],
    #[serde(default)]
    pub rot: [f32; 3],
    #[serde(default = "unit_scale")]
    pub scale: [f32; 3],
    /// Head (0 to 3) of each model extruder, as for a single file.
    #[serde(default)]
    pub extruder_map: Vec<u8>,
}

fn unit_scale() -> [f32; 3] {
    [1.0, 1.0, 1.0]
}

/// Rotation matrix: X first, then Y, then Z (angles in degrees).
pub fn rotation(rot: [f32; 3]) -> [[f32; 3]; 3] {
    let (a, b, c) = (rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians());
    let (sa, ca, sb, cb, sc, cc) = (a.sin(), a.cos(), b.sin(), b.cos(), c.sin(), c.cos());
    // Rz · Ry · Rx
    [
        [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
        [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
        [-sb, cb * sa, cb * ca],
    ]
}

/// Lays the (centered) triangles on the plate following the object's placement.
pub fn place(tris: &mut [Tri], it: &SceneItem) {
    let r = rotation(it.rot);
    let s = it.scale;
    let mut zmin = f32::MAX;
    for t in tris.iter_mut() {
        for v in &mut t.v {
            let p = [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
            *v = [
                r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
                r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
                r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
            ];
            zmin = zmin.min(v[2]);
        }
        // A negative scale flips the faces: restore the winding.
        if s[0] * s[1] * s[2] < 0.0 {
            t.v.swap(1, 2);
        }
    }
    for t in tris.iter_mut() {
        for v in &mut t.v {
            v[0] += it.pos[0];
            v[1] += it.pos[1];
            v[2] -= zmin;
        }
    }
}

/// Outcome of writing a scene.
#[derive(Debug, Default)]
pub struct Written {
    pub kept: usize,
    /// Objects entirely off the plate, not sliced.
    pub skipped: Vec<String>,
}

/// Writes the scene into a 3MF ready for the engine (placements applied,
/// multicolor parts spread over their heads).
///
/// An object entirely off the plate is left out (objects of a 3MF's other
/// plates, for instance); an object partly sticking out stops everything.
pub fn write_scene(scene: &[SceneItem], bed: (f32, f32), dst: &Path) -> Result<Written> {
    write_items(scene, Some(bed), dst)
}

/// Saves the whole plate as 3MF, without plate checks.
pub fn save_scene(scene: &[SceneItem], dst: &Path) -> Result<()> {
    write_items(scene, None, dst).map(|_| ())
}

fn write_items(scene: &[SceneItem], bed: Option<(f32, f32)>, dst: &Path) -> Result<Written> {
    let mut objects: Vec<(String, Vec<crate::write3mf::Part>)> = Vec::new();
    let mut written = Written::default();
    for it in scene {
        let path = Path::new(&it.path);
        let (mut m, _) = load(path, it.item, FULL_BUDGET)?;
        let name = if it.name.is_empty() { format!("object {}", objects.len() + 1) } else { it.name.clone() };
        if m.truncated {
            return Err(anyhow!(crate::t!("err.too_dense", name = name)));
        }
        place(&mut m.tris, it);
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for t in &m.tris {
            for v in &t.v {
                x0 = x0.min(v[0]);
                y0 = y0.min(v[1]);
                x1 = x1.max(v[0]);
                y1 = y1.max(v[1]);
            }
        }
        if let Some(bed) = bed {
            // Tolerance of a tenth of a millimeter on the edges.
            let eps = 0.1;
            let outside = x1 < -eps || y1 < -eps || x0 > bed.0 + eps || y0 > bed.1 + eps;
            if outside {
                written.skipped.push(name);
                continue;
            }
            if x0 < -eps || y0 < -eps || x1 > bed.0 + eps || y1 > bed.1 + eps {
                return Err(anyhow!(crate::t!("err.sticks_out", name = name)));
            }
        }

        let head_of = |e: u8| -> u8 {
            it.extruder_map.get(e.saturating_sub(1) as usize).copied().unwrap_or(0).min(15)
        };
        let mut groups: std::collections::BTreeMap<u8, Vec<Tri>> = Default::default();
        if m.extruders.len() == m.tris.len() {
            for (t, e) in m.tris.iter().zip(&m.extruders) {
                groups.entry(head_of(*e)).or_default().push(*t);
            }
        } else {
            groups.insert(head_of(1), m.tris);
        }
        let parts = groups
            .into_iter()
            .map(|(head, tris)| crate::write3mf::Part { name: format!("{name} — T{head}"), tris, extruder: head + 1 })
            .collect();
        objects.push((name, parts));
    }
    if objects.is_empty() {
        return Err(anyhow!(crate::t!("prepare.nothing")));
    }
    written.kept = objects.len();
    crate::write3mf::write_objects(dst, &objects)?;
    Ok(written)
}

// ------------------------------------------------------------ orientation

/// Convex hull of an object, in its own frame (the display mesh's): used to
/// rest it exactly and compute its footprint.
pub fn hull(path: &Path, index: usize) -> Result<crate::orient::Hull> {
    let (m, _) = load(path, index, 1_500_000)?;
    crate::orient::convex_hull(&crate::orient::unique_points(&m.tris))
}

/// Object to orient: the scale matters (it changes the face angles).
#[derive(Deserialize, Clone, Debug)]
pub struct OrientItem {
    pub path: String,
    pub item: usize,
    #[serde(default = "unit_scale")]
    pub scale: [f32; 3],
}

/// Rotation (rows) bringing the object's best direction upwards, following
/// Orca's rules (`orient.rs`), in the object's own frame.
pub fn orient(it: &OrientItem, threshold_deg: f64) -> Result<[[f64; 3]; 3]> {
    let (mut m, _) = load(Path::new(&it.path), it.item, 300_000)?;
    let s = it.scale;
    for t in &mut m.tris {
        for v in &mut t.v {
            *v = [v[0] * s[0], v[1] * s[1], v[2] * s[2]];
        }
    }
    let up = crate::orient::best_up(&m.tris, threshold_deg)?;
    Ok(crate::orient::rotation_between(up, [0.0, 0.0, 1.0]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Mat;

    fn cube(z0: f32, s: f32) -> Vec<Tri> {
        let p = [
            [0., 0., z0], [s, 0., z0], [s, s, z0], [0., s, z0],
            [0., 0., z0 + s], [s, 0., z0 + s], [s, s, z0 + s], [0., s, z0 + s],
        ];
        let f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
                 [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        f.iter().map(|t| Tri { v: [p[t[0]], p[t[1]], p[t[2]]], c: [100, 100, 100] }).collect()
    }

    #[test]
    fn rotation_order_is_x_then_y_then_z() {
        // 90° around Z sends X onto Y.
        let r = rotation([0., 0., 90.]);
        let v = [r[0][0], r[1][0], r[2][0]];
        assert!((v[0]).abs() < 1e-6 && (v[1] - 1.0).abs() < 1e-6);
        // X then Z: the Y axis, rotated 90° around X, becomes Z; Z stays Z.
        let r = rotation([90., 0., 90.]);
        let y = [r[0][1], r[1][1], r[2][1]];
        assert!((y[2] - 1.0).abs() < 1e-6, "{y:?}");
    }

    #[test]
    fn placing_rests_the_object_on_the_bed() {
        let mut t = cube(-5.0, 10.0); // centered in Z on 0
        let it = SceneItem {
            path: String::new(),
            item: 0,
            name: "c".into(),
            pos: [100.0, 50.0],
            rot: [0.0, 0.0, 45.0],
            scale: [2.0, 2.0, 2.0],
            extruder_map: vec![],
        };
        place(&mut t, &it);
        let zmin = t.iter().flat_map(|t| t.v).map(|v| v[2]).fold(f32::MAX, f32::min);
        let zmax = t.iter().flat_map(|t| t.v).map(|v| v[2]).fold(f32::MIN, f32::max);
        assert!(zmin.abs() < 1e-4, "rested: {zmin}");
        assert!((zmax - 20.0).abs() < 1e-3, "scale 2: {zmax}");
    }

    /// A file of two objects, one on the plate, the other far away (a second
    /// plate): the second is left out, the first written in place.
    #[test]
    fn scene_keeps_bed_objects_and_skips_the_others() {
        let tmp = std::env::temp_dir().join("snapstudio-plate-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("two.3mf");
        crate::write3mf::write_scene(
            &src,
            &[
                crate::write3mf::SceneObject { name: "ici".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None },
                crate::write3mf::SceneObject { name: "far away".into(), tris: cube(0., 10.), transform: Mat::IDENTITY, extruder: None },
            ],
        )
        .unwrap();
        let found = items(&src).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].size, [10.0, 10.0, 10.0]);

        let item = |i: usize, x: f32| SceneItem {
            path: src.to_string_lossy().to_string(),
            item: i,
            name: found[i].name.clone(),
            pos: [x, 100.0],
            rot: [0.0, 0.0, 30.0],
            scale: unit_scale(),
            extruder_map: vec![2],
        };
        let out = tmp.join("scene.3mf");
        let w = write_scene(&[item(0, 100.0), item(1, 600.0)], (270.0, 270.0), &out).unwrap();
        assert_eq!(w.kept, 1);
        assert_eq!(w.skipped, vec![found[1].name.clone()]);

        let mut zip = crate::model3mf::open(&out).unwrap();
        let m = crate::mesh::load_mesh(&mut zip, 10_000).unwrap();
        assert!((m.min[2]).abs() < 1e-3, "rested at Z = 0");
        let cx = (m.min[0] + m.max[0]) / 2.0;
        assert!((cx - 100.0).abs() < 0.01, "centered at X = 100: {cx}");
        assert!(m.extruders.iter().all(|e| *e == 3), "model extruder 1 → head 2");

        // An object sticking out stops slicing.
        let err = write_scene(&[item(0, 268.0)], (270.0, 270.0), &out).unwrap_err();
        assert!(err.to_string().contains("sticks out"), "{err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
