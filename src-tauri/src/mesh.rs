//! Reading 3MF geometry (core + multi-file "production" extension).

use crate::model3mf::{read_entry, Zip};
use anyhow::{anyhow, Result};
use quick_xml::events::Event;
use std::collections::HashMap;

/// 3MF 4x3 matrix: row 3 = translation, point' = [x y z 1] * M.
#[derive(Clone, Copy, Debug)]
pub struct Mat(pub [f32; 12]);

impl Mat {
    pub const IDENTITY: Mat = Mat([1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0.]);

    fn parse(s: &str) -> Mat {
        let mut m = Mat::IDENTITY;
        for (i, tok) in s.split_whitespace().take(12).enumerate() {
            m.0[i] = tok.parse().unwrap_or(m.0[i]);
        }
        m
    }

    #[inline]
    fn apply(&self, p: [f32; 3]) -> [f32; 3] {
        let m = &self.0;
        [
            p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9],
            p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10],
            p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11],
        ]
    }

    /// `self` applied first, then `parent`.
    fn then(&self, parent: &Mat) -> Mat {
        let (c, p) = (&self.0, &parent.0);
        let mut o = [0f32; 12];
        for i in 0..3 {
            for j in 0..3 {
                o[i * 3 + j] = c[i * 3] * p[j] + c[i * 3 + 1] * p[3 + j] + c[i * 3 + 2] * p[6 + j];
            }
        }
        for j in 0..3 {
            o[9 + j] = c[9] * p[j] + c[10] * p[3 + j] + c[11] * p[6 + j] + p[9 + j];
        }
        Mat(o)
    }
}

#[derive(Default)]
struct Obj {
    verts: Vec<[f32; 3]>,
    tris: Vec<[u32; 3]>,
    /// Optional color per triangle (p1 attribute -> material group).
    tri_colors: Vec<Option<[u8; 3]>>,
    color: Option<[u8; 3]>,
    components: Vec<(Option<String>, u32, Mat)>,
}

#[derive(Default)]
struct Part {
    objects: HashMap<u32, Obj>,
    build: Vec<(u32, Mat, Option<String>)>,
}

#[derive(Clone, Copy)]
pub struct Tri {
    pub v: [[f32; 3]; 3],
    pub c: [u8; 3],
}

pub struct MeshData {
    pub tris: Vec<Tri>,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub truncated: bool,
    /// Model extruder for each triangle (1 to 16), when the file declares it
    /// (`model_settings.config`); empty otherwise.
    pub extruders: Vec<u8>,
}

impl MeshData {
    pub fn size(&self) -> [f32; 3] {
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }
}

fn parse_color(s: &str) -> Option<[u8; 3]> {
    let s = s.trim().trim_start_matches('#');
    if s.len() < 6 {
        return None;
    }
    Some([
        u8::from_str_radix(&s[0..2], 16).ok()?,
        u8::from_str_radix(&s[2..4], 16).ok()?,
        u8::from_str_radix(&s[4..6], 16).ok()?,
    ])
}

/// Parses a .model file (root or external object).
fn parse_part(data: &[u8]) -> Part {
    let mut part = Part::default();
    let mut reader = quick_xml::Reader::from_reader(data);
    reader.config_mut().trim_text(true);
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::new();

    // Color groups: id -> palette
    let mut groups: HashMap<u32, Vec<[u8; 3]>> = HashMap::new();
    let mut cur_group: Option<u32> = None;

    let mut cur_id: Option<u32> = None;
    let mut cur = Obj::default();
    let mut cur_pid: Option<u32> = None;
    let mut cur_pindex: usize = 0;
    let mut pending_tri_refs: Vec<(usize, u32, u32)> = Vec::new(); // (index triangle, pid, p1)

    loop {
        let ev = reader.read_event_into(&mut buf);
        let empty = matches!(&ev, Ok(Event::Empty(_)));
        match ev {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                match e.local_name().as_ref() {
                    "basematerials" | "colorgroup" => {
                        let mut id = None;
                        for a in e.attributes().flatten() {
                            if a.key.local_name().as_ref() == "id" {
                                id = crate::model3mf::aval(&a).parse::<u32>().ok();
                            }
                        }
                        cur_group = id;
                        if let Some(id) = id {
                            groups.entry(id).or_default();
                        }
                    }
                    "base" | "color" => {
                        if let Some(g) = cur_group {
                            let mut col = None;
                            for a in e.attributes().flatten() {
                                let k = a.key.local_name();
                                if k.as_ref() == "displaycolor" || k.as_ref() == "color" {
                                    col = parse_color(&crate::model3mf::aval(&a));
                                }
                            }
                            groups.entry(g).or_default().push(col.unwrap_or([200, 200, 205]));
                        }
                    }
                    "object" => {
                        cur = Obj::default();
                        pending_tri_refs.clear();
                        cur_pid = None;
                        cur_pindex = 0;
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "id" => cur_id = v.parse().ok(),
                                "pid" => cur_pid = v.parse().ok(),
                                "pindex" => cur_pindex = v.parse().unwrap_or(0),
                                _ => {}
                            }
                        }
                    }
                    "vertex" => {
                        let (mut x, mut y, mut z) = (0f32, 0f32, 0f32);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "x" => x = v.parse().unwrap_or(0.),
                                "y" => y = v.parse().unwrap_or(0.),
                                "z" => z = v.parse().unwrap_or(0.),
                                _ => {}
                            }
                        }
                        cur.verts.push([x, y, z]);
                    }
                    "triangle" => {
                        let (mut a1, mut a2, mut a3) = (0u32, 0u32, 0u32);
                        let (mut pid, mut p1) = (None, None);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "v1" => a1 = v.parse().unwrap_or(0),
                                "v2" => a2 = v.parse().unwrap_or(0),
                                "v3" => a3 = v.parse().unwrap_or(0),
                                "pid" => pid = v.parse::<u32>().ok(),
                                "p1" => p1 = v.parse::<u32>().ok(),
                                _ => {}
                            }
                        }
                        let idx = cur.tris.len();
                        cur.tris.push([a1, a2, a3]);
                        cur.tri_colors.push(None);
                        if let (Some(pid), Some(p1)) = (pid.or(cur_pid), p1) {
                            pending_tri_refs.push((idx, pid, p1));
                        }
                    }
                    "component" => {
                        let (mut objectid, mut path, mut xf) = (0u32, None, Mat::IDENTITY);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "objectid" => objectid = v.parse().unwrap_or(0),
                                "path" => path = Some(v.to_string()),
                                "transform" => xf = Mat::parse(&v),
                                _ => {}
                            }
                        }
                        cur.components.push((path, objectid, xf));
                    }
                    "item" => {
                        let (mut objectid, mut xf, mut path) = (0u32, Mat::IDENTITY, None);
                        for a in e.attributes().flatten() {
                            let v = crate::model3mf::aval(&a);
                            match a.key.local_name().as_ref() {
                                "objectid" => objectid = v.parse().unwrap_or(0),
                                "transform" => xf = Mat::parse(&v),
                                "path" => path = Some(v.to_string()),
                                _ => {}
                            }
                        }
                        part.build.push((objectid, xf, path));
                    }
                    _ => {}
                }
                if empty {
                    if matches!(e.local_name().as_ref(), "basematerials" | "colorgroup") {
                        cur_group = None;
                    }
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "basematerials" | "colorgroup" => cur_group = None,
                "object" => {
                    if let Some(id) = cur_id.take() {
                        // Deferred colors: groups may be declared after the object.
                        let mut obj = std::mem::take(&mut cur);
                        obj.color = cur_pid
                            .and_then(|pid| groups.get(&pid))
                            .and_then(|g| g.get(cur_pindex).copied());
                        for (ti, pid, p1) in pending_tri_refs.drain(..) {
                            if let Some(c) = groups.get(&pid).and_then(|g| g.get(p1 as usize)) {
                                obj.tri_colors[ti] = Some(*c);
                            }
                        }
                        part.objects.insert(id, obj);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    // Second pass for objects whose color group had not been read yet.
    let group_keys: Vec<u32> = groups.keys().copied().collect();
    let _ = group_keys;
    part
}

/// An object occurrence in the scene, already resolved (file, id, transform).
struct Inst {
    part_key: String,
    objid: u32,
    /// `<build>` object this occurrence comes from.
    root: u32,
    xf: Mat,
    color: Option<[u8; 3]>,
}

struct Ctx<'a> {
    zip: &'a mut Zip,
    parts: HashMap<String, Part>,
}

impl<'a> Ctx<'a> {
    /// Loads a .model file of the container (only once).
    fn part(&mut self, key: &str) -> bool {
        if self.parts.contains_key(key) {
            return true;
        }
        let Some(data) = read_entry(self.zip, key.trim_start_matches('/')) else {
            return false;
        };
        self.parts.insert(key.to_string(), parse_part(&data));
        true
    }

    /// Resolves components recursively without touching the meshes.
    #[allow(clippy::too_many_arguments)]
    fn collect(
        &mut self,
        part_key: &str,
        objid: u32,
        root: u32,
        xf: Mat,
        inherited: Option<[u8; 3]>,
        depth: u32,
        out: &mut Vec<Inst>,
    ) {
        if depth > 12 || out.len() > 100_000 {
            return;
        }
        if !self.part(part_key) {
            return;
        }
        let Some(obj) = self.parts.get(part_key).and_then(|p| p.objects.get(&objid)) else {
            return;
        };
        let color = obj.color.or(inherited);
        let has_mesh = !obj.tris.is_empty();
        let components = obj.components.clone();
        if has_mesh {
            out.push(Inst {
                part_key: part_key.to_string(),
                objid,
                root,
                xf,
                color,
            });
        }
        for (path, id, cxf) in components {
            let key = path.unwrap_or_else(|| part_key.to_string());
            self.collect(&key, id, root, cxf.then(&xf), color, depth + 1, out);
        }
    }
}

/// Loads and flattens the 3MF file's geometry.
pub fn load_mesh(zip: &mut Zip, budget: usize) -> Result<MeshData> {
    let root_key = "3D/3dmodel.model".to_string();
    let mut ctx = Ctx {
        zip,
        parts: HashMap::new(),
    };
    if !ctx.part(&root_key) {
        return Err(anyhow!(crate::t!("err.no_model")));
    }

    // 1. Scene resolution: which objects, where, in what color.
    let build: Vec<(u32, Mat, Option<String>)> = ctx
        .parts
        .get(&root_key)
        .map(|p| p.build.clone())
        .unwrap_or_default();
    let mut insts = Vec::new();
    if build.is_empty() {
        // Some exports have no <build>: take all the objects.
        let ids: Vec<u32> = ctx
            .parts
            .get(&root_key)
            .map(|p| p.objects.keys().copied().collect())
            .unwrap_or_default();
        for id in ids {
            ctx.collect(&root_key, id, id, Mat::IDENTITY, None, 0, &mut insts);
        }
    } else {
        for (id, xf, path) in build {
            let key = path.unwrap_or_else(|| root_key.clone());
            ctx.collect(&key, id, id, xf, None, 0, &mut insts);
        }
    }

    emit(&mut ctx, &insts, budget)
}


/// Emits the transformed triangles of the occurrences, without copying meshes.
fn emit(ctx: &mut Ctx<'_>, insts: &[Inst], budget: usize) -> Result<MeshData> {
    let total: usize = insts
        .iter()
        .filter_map(|i| ctx.parts.get(&i.part_key)?.objects.get(&i.objid))
        .map(|o| o.tris.len())
        .sum();
    let step = if total > budget {
        (total as f32 / budget as f32).ceil() as usize
    } else {
        1
    };
    let mut tris: Vec<Tri> = Vec::with_capacity(total.min(budget) + 8);
    // Extruder of each occurrence: the part's, otherwise the object's.
    let settings = crate::model3mf::extruder_settings(ctx.zip);
    let mut extruders: Vec<u8> = Vec::new();
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    for inst in insts {
        let Some(obj) = ctx.parts.get(&inst.part_key).and_then(|p| p.objects.get(&inst.objid))
        else {
            continue;
        };
        let base = inst.color;
        let ext = settings.get(&inst.root).map(|(obj, parts)| {
            parts.get(&inst.objid).copied().filter(|e| *e > 0).unwrap_or(*obj).max(1)
        });
        for (i, t) in obj.tris.iter().enumerate() {
            // On very dense meshes, sample instead of truncating: the silhouette stays
            // right.
            if step > 1 && i % step != 0 {
                continue;
            }
            let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
            if a >= obj.verts.len() || b >= obj.verts.len() || c >= obj.verts.len() {
                continue;
            }
            let v = [
                inst.xf.apply(obj.verts[a]),
                inst.xf.apply(obj.verts[b]),
                inst.xf.apply(obj.verts[c]),
            ];
            for p in &v {
                for k in 0..3 {
                    min[k] = min[k].min(p[k]);
                    max[k] = max[k].max(p[k]);
                }
            }
            tris.push(Tri {
                v,
                c: obj.tri_colors[i].or(base).unwrap_or(crate::render::DEFAULT_COLOR),
            });
            if let Some(e) = ext {
                extruders.resize(tris.len() - 1, 1);
                extruders.push(e);
            }
        }
    }

    if tris.is_empty() {
        return Err(anyhow!(crate::t!("err.no_geometry")));
    }
    // Occurrences without a setting are attached to extruder 1.
    if !extruders.is_empty() {
        extruders.resize(tris.len(), 1);
    }
    Ok(MeshData {
        extruders,
        tris,
        min,
        max,
        truncated: step > 1,
    })}

/// An occurrence of the `<build>`: object, placement in the scene.
#[derive(Clone, Copy, Debug)]
pub struct BuildItem {
    pub objid: u32,
    pub xf: Mat,
}

/// Occurrences of the main model's `<build>`, in file order.
pub fn build_items(zip: &mut Zip) -> Result<Vec<BuildItem>> {
    let root_key = "3D/3dmodel.model".to_string();
    let mut ctx = Ctx { zip, parts: HashMap::new() };
    if !ctx.part(&root_key) {
        return Err(anyhow!(crate::t!("err.no_model")));
    }
    let part = ctx.parts.get(&root_key).unwrap();
    let mut items: Vec<BuildItem> = part.build.iter().map(|(id, xf, _)| BuildItem { objid: *id, xf: *xf }).collect();
    if items.is_empty() {
        let mut ids: Vec<u32> = part.objects.keys().copied().collect();
        ids.sort_unstable();
        items = ids.into_iter().map(|objid| BuildItem { objid, xf: Mat::IDENTITY }).collect();
    }
    Ok(items)
}

/// An object of the `<build>`, isolated for the plate.
pub struct ItemMesh {
    /// Triangles centered on the bounding box center, oriented as in the file
    /// (the linear part of the placement is applied).
    pub mesh: MeshData,
    /// Position of the center in the file's scene.
    pub center: [f32; 3],
}

/// Loads occurrence `index` of the `<build>`, in its own frame.
pub fn load_item(zip: &mut Zip, index: usize, budget: usize) -> Result<ItemMesh> {
    let root_key = "3D/3dmodel.model".to_string();
    let item = *build_items(zip)?
        .get(index)
        .ok_or_else(|| anyhow!(crate::t!("err.no_object", index = index)))?;
    let mut ctx = Ctx { zip, parts: HashMap::new() };
    if !ctx.part(&root_key) {
        return Err(anyhow!(crate::t!("err.no_model")));
    }
    // The file's orientation and scale kept, translation removed: the position
    // becomes the plate's.
    let mut lin = item.xf;
    let t = [lin.0[9], lin.0[10], lin.0[11]];
    lin.0[9] = 0.0;
    lin.0[10] = 0.0;
    lin.0[11] = 0.0;
    let mut insts = Vec::new();
    ctx.collect(&root_key, item.objid, item.objid, lin, None, 0, &mut insts);
    let mut mesh = emit(&mut ctx, &insts, budget)?;
    let c = [
        (mesh.min[0] + mesh.max[0]) / 2.0,
        (mesh.min[1] + mesh.max[1]) / 2.0,
        (mesh.min[2] + mesh.max[2]) / 2.0,
    ];
    for tri in &mut mesh.tris {
        for v in &mut tri.v {
            for k in 0..3 {
                v[k] -= c[k];
            }
        }
    }
    for k in 0..3 {
        mesh.min[k] -= c[k];
        mesh.max[k] -= c[k];
    }
    Ok(ItemMesh { mesh, center: [c[0] + t[0], c[1] + t[1], c[2] + t[2]] })
}

/// What can be said about a mesh without slicing it.
#[derive(serde::Serialize, Clone, Copy)]
pub struct Stats {
    pub triangles: usize,
    pub size: [f32; 3],
    /// Volume in cubic centimeters, computed as a sum of tetrahedra. Only
    /// meaningful if the mesh is closed.
    pub volume_cm3: f32,
    /// `None` when the mesh is too dense to check cheaply.
    pub watertight: Option<bool>,
}

/// Beyond this, the watertightness check costs more than it brings: it
/// indexes three edges per face, and would delay the preview it comes with.
const WATERTIGHT_BUDGET: usize = 400_000;

/// Watertight in the edge sense: each edge must be shared by exactly two
/// faces. It is the test that best predicts whether a slicer accepts the part.
///
/// Vertices are rounded to the micron before comparing: two floats from
/// different computations often describe the same point without being equal.
fn edges_are_paired(tris: &[Tri]) -> bool {
    let key = |p: [f32; 3]| -> [i64; 3] {
        [
            (p[0] as f64 * 1000.0).round() as i64,
            (p[1] as f64 * 1000.0).round() as i64,
            (p[2] as f64 * 1000.0).round() as i64,
        ]
    };
    let mut ids: HashMap<[i64; 3], u32> = HashMap::with_capacity(tris.len());
    let mut edges: HashMap<(u32, u32), i32> = HashMap::with_capacity(tris.len() * 2);
    for t in tris {
        let mut v = [0u32; 3];
        for (k, p) in t.v.iter().enumerate() {
            let next = ids.len() as u32;
            v[k] = *ids.entry(key(*p)).or_insert(next);
        }
        if v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            continue; // degenerate triangle: it closes nothing
        }
        for (a, b) in [(v[0], v[1]), (v[1], v[2]), (v[2], v[0])] {
            let e = if a < b { (a, b) } else { (b, a) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&n| n == 2)
}

pub fn stats(m: &MeshData) -> Stats {
    let mut vol = 0f64;
    for t in &m.tris {
        let [a, b, c] = t.v;
        vol += (a[0] as f64 * (b[1] as f64 * c[2] as f64 - b[2] as f64 * c[1] as f64)
            - a[1] as f64 * (b[0] as f64 * c[2] as f64 - b[2] as f64 * c[0] as f64)
            + a[2] as f64 * (b[0] as f64 * c[1] as f64 - b[1] as f64 * c[0] as f64))
            / 6.0;
    }
    Stats {
        triangles: m.tris.len(),
        size: m.size(),
        volume_cm3: (vol.abs() / 1000.0) as f32,
        watertight: (m.tris.len() <= WATERTIGHT_BUDGET).then(|| edges_are_paired(&m.tris)),
    }
}

/// Reduces a mesh to the viewer's budget.
///
/// The bounding box stays the full mesh's: the display is lightened, the object
/// is not trimmed.
pub fn downsample(mesh: &mut MeshData, budget: usize) {
    if budget == 0 || mesh.tris.len() <= budget {
        return;
    }
    let step = (mesh.tris.len() as f32 / budget as f32).ceil() as usize;
    let mut i = 0usize;
    mesh.tris.retain(|_| {
        let keep = i % step == 0;
        i += 1;
        keep
    });
    mesh.truncated = true;
}

/// Serializes the mesh for the WebGL viewer.
///
/// Layout, all little-endian:
/// `"3MFM"` | version u8 | flags u8 (bit 0: sampled mesh) |
/// reserved u8×2 | triangle count u32 |
/// min x,y,z f32 | max x,y,z f32 | positions (9 f32 per triangle) |
/// colors (3 u8 per triangle).
pub fn encode(mesh: &MeshData) -> Vec<u8> {
    let n = mesh.tris.len();
    let mut out = Vec::with_capacity(24 + n * (36 + 3));
    out.extend_from_slice(b"3MFM");
    out.push(1);
    out.push(if mesh.truncated { 1 } else { 0 });
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(n as u32).to_le_bytes());
    for v in mesh.min.iter().chain(mesh.max.iter()) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for t in &mesh.tris {
        for v in &t.v {
            for c in v {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
    }
    for t in &mesh.tris {
        out.extend_from_slice(&t.c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes the encoded mesh of a real file, for the viewer test.
    #[test]
    fn dump_for_viewer() {
        let (Ok(src), Ok(out)) = (std::env::var("DUMP_3MF"), std::env::var("DUMP_OUT")) else {
            return;
        };
        let mut zip = crate::model3mf::open(std::path::Path::new(&src)).unwrap();
        let m = load_mesh(&mut zip, 900_000).unwrap();
        let bytes = encode(&m);
        println!(
            "{} triangles, {} octets, encombrement {:?}",
            m.tris.len(),
            bytes.len(),
            m.size()
        );
        std::fs::write(out, bytes).unwrap();
    }

    /// The encoding must match what the viewer reads.
    #[test]
    fn encode_layout() {
        let m = MeshData {
            extruders: Vec::new(),
            tris: vec![
                Tri { v: [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], c: [10, 20, 30] },
                Tri { v: [[0., 0., 1.], [1., 0., 1.], [0., 1., 1.]], c: [40, 50, 60] },
            ],
            min: [0., 0., 0.],
            max: [1., 1., 1.],
            truncated: true,
        };
        let b = encode(&m);
        assert_eq!(&b[0..4], b"3MFM");
        assert_eq!(b[4], 1, "version");
        assert_eq!(b[5], 1, "sampling flag");
        assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()), 2);
        assert_eq!(b.len(), 36 + 2 * 36 + 2 * 3);
        // First coordinate of the second vertex of the first triangle.
        let off = 36 + 3 * 4;
        assert_eq!(f32::from_le_bytes(b[off..off + 4].try_into().unwrap()), 1.0);
        // Colors at the end of the buffer.
        assert_eq!(&b[b.len() - 6..], &[10, 20, 30, 40, 50, 60]);
    }
}

#[cfg(test)]
mod stats_tests {
    use super::*;

    #[test]
    fn a_closed_cube_is_watertight() {
        let tris = crate::stl::tests_cube();
        let m = MeshData {
            extruders: Vec::new(),
            min: [0.; 3],
            max: [10.; 3],
            tris,
            truncated: false,
        };
        let s = stats(&m);
        assert_eq!(s.triangles, 12);
        assert_eq!(s.watertight, Some(true));
        // 10 mm sides: 1 cm³.
        assert!((s.volume_cm3 - 1.0).abs() < 1e-3, "volume {}", s.volume_cm3);
    }

    #[test]
    fn an_open_cube_is_not() {
        let mut tris = crate::stl::tests_cube();
        tris.truncate(10); // remove one face
        let m = MeshData {
            extruders: Vec::new(),
            min: [0.; 3],
            max: [10.; 3],
            tris,
            truncated: false,
        };
        assert_eq!(stats(&m).watertight, Some(false));
    }
}
