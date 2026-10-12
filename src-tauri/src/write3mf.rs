//! Écriture de fichiers 3MF.
//!
//! Deux usages, volontairement distincts :
//!
//! * [`strip_project`] recopie un 3MF existant en laissant de côté ses réglages
//!   de projet. Les octets de la géométrie ne sont pas touchés : rien à
//!   ré-encoder, aucune précision perdue. C'est ce qui permet d'ajouter une
//!   pièce au plateau d'un trancheur sans écraser sa session, et c'est aussi le
//!   contournement du plantage de la ligne de commande de Snapmaker Orca sur
//!   les fichiers de projet.
//! * [`write_scene`] compose un 3MF neuf à partir de maillages et de leurs
//!   placements, pour un plateau que l'on arrange soi-même.
//!
//! Attention en aval : la ligne de commande d'Orca réarrange le plateau d'office.
//! Pour que le placement écrit ici soit celui qui s'imprime, il faut l'appeler
//! avec `--arrange 0`. Vérifié : sans ce drapeau les pièces sont déplacées,
//! avec lui elles restent à 0,3 mm près — l'écart étant la demi-largeur du
//! cordon d'extrusion.

use crate::mesh::{Mat, Tri};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::Path;

/// Entrées de projet qu'un trancheur relit comme « c'est un projet, pas un
/// modèle » : les laisser de côté transforme le fichier en simple géométrie.
const PROJECT_ENTRIES: &[&str] = &[
    "metadata/project_settings.config",
    "metadata/slice_info.config",
    "metadata/cut_information.xml",
];

fn is_project_entry(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    PROJECT_ENTRIES.contains(&l.as_str())
        || l.starts_with("metadata/plate_")
        || l.starts_with("metadata/top_")
        || l.starts_with("metadata/pick_")
}

/// Recopie `src` vers `dst` sans ses réglages de projet.
///
/// Renvoie le nombre d'entrées écartées.
pub fn strip_project(src: &Path, dst: &Path) -> Result<usize> {
    let mut zin = crate::model3mf::open(src)?;
    let out = File::create(dst)?;
    let mut zout = zip::ZipWriter::new(BufWriter::new(out));
    let mut dropped = 0;

    let names: Vec<String> = zin.file_names().map(|s| s.to_string()).collect();
    for name in names {
        if is_project_entry(&name) {
            dropped += 1;
            continue;
        }
        let mut f = zin.by_name(&name)?;
        if f.is_dir() {
            continue;
        }
        let mut buf = Vec::with_capacity(f.size().min(256 << 20) as usize);
        f.read_to_end(&mut buf)?;
        drop(f);
        zout.start_file(
            &name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )?;
        zout.write_all(&buf)?;
    }
    zout.finish()?;
    Ok(dropped)
}

/// Un objet à poser sur le plateau.
pub struct SceneObject {
    pub name: String,
    /// Triangles dans le repère de l'objet.
    pub tris: Vec<Tri>,
    /// Placement sur le plateau.
    pub transform: Mat,
    /// Tête affectée, de 1 à 4 ; `None` laisse le trancheur décider.
    pub extruder: Option<u8>,
}

#[allow(dead_code)]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Regroupe les sommets identiques : un maillage à sommets partagés se découpe
/// bien mieux qu'une soupe de triangles.
#[allow(dead_code)]
fn weld(tris: &[Tri]) -> (Vec<[f32; 3]>, Vec<[u32; 3]>) {
    let mut verts: Vec<[f32; 3]> = Vec::with_capacity(tris.len());
    let mut index: HashMap<[u32; 3], u32> = HashMap::with_capacity(tris.len());
    let mut faces = Vec::with_capacity(tris.len());
    for t in tris {
        let mut f = [0u32; 3];
        for (k, v) in t.v.iter().enumerate() {
            let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
            let id = *index.entry(key).or_insert_with(|| {
                verts.push(*v);
                (verts.len() - 1) as u32
            });
            f[k] = id;
        }
        // Un triangle dégénéré fait échouer la réparation du trancheur.
        if f[0] != f[1] && f[1] != f[2] && f[0] != f[2] {
            faces.push(f);
        }
    }
    (verts, faces)
}

fn mat_str(m: &Mat) -> String {
    m.0.iter()
        .map(|v| format!("{v}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Identifiant du groupe de matériaux (palette des couleurs).
const MAT_ID: u32 = 1;

/// Écrit un maillage comme `<object>` du modèle, couleurs comprises.
fn write_mesh_object<W: Write>(
    w: &mut W,
    id: u32,
    name: &str,
    tris: &[Tri],
    color_id: &HashMap<[u8; 3], usize>,
) -> Result<()> {
    let (verts, faces) = weld(tris);
    if faces.is_empty() {
        return Err(anyhow!("objet « {} » sans triangle exploitable", name));
    }
    let single = tris.first().map(|t| t.c).filter(|c| tris.iter().all(|t| t.c == *c));
    match single {
        Some(c) => writeln!(
            w,
            r#"  <object id="{id}" type="model" name="{}" pid="{MAT_ID}" pindex="{}">"#,
            xml_escape(name),
            color_id[&c]
        )?,
        None => writeln!(
            w,
            r#"  <object id="{id}" type="model" name="{}">"#,
            xml_escape(name)
        )?,
    }
    writeln!(w, "   <mesh>")?;
    writeln!(w, "    <vertices>")?;
    for v in &verts {
        writeln!(
            w,
            r#"     <vertex x="{:.6}" y="{:.6}" z="{:.6}"/>"#,
            v[0], v[1], v[2]
        )?;
    }
    writeln!(w, "    </vertices>")?;
    writeln!(w, "    <triangles>")?;
    let mut fi = 0usize;
    for t in tris {
        // `weld` a pu écarter des triangles dégénérés : on suit le même ordre.
        let (a, b, c) = (t.v[0], t.v[1], t.v[2]);
        let deg = a == b || b == c || a == c;
        if deg {
            continue;
        }
        let f = faces[fi];
        fi += 1;
        if single.is_some() {
            writeln!(
                w,
                r#"     <triangle v1="{}" v2="{}" v3="{}"/>"#,
                f[0], f[1], f[2]
            )?;
        } else {
            writeln!(
                w,
                r#"     <triangle v1="{}" v2="{}" v3="{}" pid="{MAT_ID}" p1="{}"/>"#,
                f[0], f[1], f[2], color_id[&t.c]
            )?;
        }
    }
    writeln!(w, "    </triangles>")?;
    writeln!(w, "   </mesh>")?;
    writeln!(w, "  </object>")?;
    Ok(())
}

type Archive = zip::ZipWriter<BufWriter<File>>;

/// Ouvre l'archive et écrit les parties fixes, jusqu'au début du modèle.
fn begin_archive(dst: &Path) -> Result<(Archive, zip::write::SimpleFileOptions)> {
    let out = File::create(dst)?;
    let mut z = zip::ZipWriter::new(BufWriter::new(out));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    z.start_file("[Content_Types].xml", opts)?;
    z.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>"#,
    )?;

    z.start_file("_rels/.rels", opts)?;
    z.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"#,
    )?;

    z.start_file("3D/3dmodel.model", opts)?;
    Ok((z, opts))
}

fn begin_model<W: Write>(w: &mut W) -> Result<()> {
    writeln!(w, r#"<?xml version="1.0" encoding="UTF-8"?>"#)?;
    writeln!(
        w,
        r#"<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">"#
    )?;
    writeln!(w, r#" <metadata name="Application">Snap Studio</metadata>"#)?;
    writeln!(w, " <resources>")?;
    Ok(())
}

/// Une palette globale : chaque couleur rencontrée devient un matériau.
fn write_palette<W: Write>(w: &mut W, groups: &[&[Tri]]) -> Result<HashMap<[u8; 3], usize>> {
    let mut palette: Vec<[u8; 3]> = Vec::new();
    let mut color_id: HashMap<[u8; 3], usize> = HashMap::new();
    for tris in groups {
        for t in tris.iter() {
            color_id.entry(t.c).or_insert_with(|| {
                palette.push(t.c);
                palette.len() - 1
            });
        }
    }
    if !palette.is_empty() {
        writeln!(w, r#"  <basematerials id="{MAT_ID}">"#)?;
        for (i, c) in palette.iter().enumerate() {
            writeln!(
                w,
                r##"   <base name="Couleur {}" displaycolor="#{:02X}{:02X}{:02X}FF"/>"##,
                i + 1,
                c[0],
                c[1],
                c[2]
            )?;
        }
        writeln!(w, "  </basematerials>")?;
    }
    Ok(color_id)
}

/// Une pièce d'un objet composé, imprimée par une tête donnée (1 à 16).
pub struct Part {
    pub name: String,
    pub tris: Vec<Tri>,
    pub extruder: u8,
}

/// Écrit un seul objet fait de plusieurs pièces, chacune avec sa tête.
///
/// C'est la forme qu'attend le trancheur pour un modèle multicolore : un objet
/// unique reste d'un bloc (une pièce posée en hauteur ne retombe pas sur le
/// plateau), et `model_settings.config` affecte une tête à chaque pièce.
pub fn write_multipart(dst: &Path, name: &str, parts: &[Part], transform: &Mat) -> Result<()> {
    write_composites(dst, &[(name, parts, *transform)])
}

/// Écrit plusieurs objets composés de pièces, placements déjà appliqués aux
/// triangles (scène du plateau).
pub fn write_objects(dst: &Path, objects: &[(String, Vec<Part>)]) -> Result<()> {
    let list: Vec<(&str, &[Part], Mat)> = objects
        .iter()
        .map(|(n, p)| (n.as_str(), p.as_slice(), Mat::IDENTITY))
        .collect();
    write_composites(dst, &list)
}

/// Objets composés : chaque pièce est un maillage, chaque objet un assemblage
/// de ses pièces, placé dans le `<build>`.
fn write_composites(dst: &Path, objects: &[(&str, &[Part], Mat)]) -> Result<()> {
    if objects.is_empty() || objects.iter().any(|(_, p, _)| p.is_empty()) {
        return Err(anyhow!("aucune pièce à écrire"));
    }
    let (mut z, opts) = begin_archive(dst)?;
    let mut w = std::io::BufWriter::with_capacity(1 << 20, &mut z);
    begin_model(&mut w)?;
    let all: Vec<&[Tri]> = objects.iter().flat_map(|(_, parts, _)| parts.iter().map(|p| p.tris.as_slice())).collect();
    let color_id = write_palette(&mut w, &all)?;

    // Identifiants : pièces d'abord (à partir de 2), puis les objets composés.
    let mut next = 2u32;
    let mut part_ids: Vec<Vec<u32>> = Vec::new();
    for (_, parts, _) in objects {
        let mut ids = Vec::new();
        for p in parts.iter() {
            write_mesh_object(&mut w, next, &p.name, &p.tris, &color_id)?;
            ids.push(next);
            next += 1;
        }
        part_ids.push(ids);
    }
    let mut whole_ids = Vec::new();
    for ((name, _, _), ids) in objects.iter().zip(&part_ids) {
        writeln!(w, r#"  <object id="{next}" type="model" name="{}">"#, xml_escape(name))?;
        writeln!(w, "   <components>")?;
        for id in ids {
            writeln!(w, r#"    <component objectid="{id}"/>"#)?;
        }
        writeln!(w, "   </components>")?;
        writeln!(w, "  </object>")?;
        whole_ids.push(next);
        next += 1;
    }
    writeln!(w, " </resources>")?;
    writeln!(w, " <build>")?;
    for ((_, _, xf), id) in objects.iter().zip(&whole_ids) {
        writeln!(w, r#"  <item objectid="{id}" transform="{}"/>"#, mat_str(xf))?;
    }
    writeln!(w, " </build>")?;
    writeln!(w, "</model>")?;
    w.flush()?;
    drop(w);

    z.start_file("Metadata/model_settings.config", opts)?;
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
    for (((name, parts, _), ids), whole) in objects.iter().zip(&part_ids).zip(&whole_ids) {
        s.push_str(&format!("  <object id=\"{whole}\">\n"));
        s.push_str(&format!("    <metadata key=\"name\" value=\"{}\"/>\n", xml_escape(name)));
        s.push_str(&format!(
            "    <metadata key=\"extruder\" value=\"{}\"/>\n",
            parts[0].extruder.clamp(1, 16)
        ));
        for (p, id) in parts.iter().zip(ids) {
            s.push_str(&format!("    <part id=\"{id}\" subtype=\"normal_part\">\n"));
            s.push_str(&format!("      <metadata key=\"name\" value=\"{}\"/>\n", xml_escape(&p.name)));
            s.push_str(&format!(
                "      <metadata key=\"extruder\" value=\"{}\"/>\n",
                p.extruder.clamp(1, 16)
            ));
            s.push_str("    </part>\n");
        }
        s.push_str("  </object>\n");
    }
    s.push_str("</config>\n");
    z.write_all(s.as_bytes())?;
    z.finish()?;
    Ok(())
}

/// Écrit un 3MF de géométrie contenant les objets et leurs placements.
pub fn write_scene(dst: &Path, objects: &[SceneObject]) -> Result<()> {
    if objects.is_empty() {
        return Err(anyhow!("aucun objet à écrire"));
    }
    let (mut z, opts) = begin_archive(dst)?;
    let mut w = std::io::BufWriter::with_capacity(1 << 20, &mut z);
    begin_model(&mut w)?;
    let all: Vec<&[Tri]> = objects.iter().map(|o| o.tris.as_slice()).collect();
    let color_id = write_palette(&mut w, &all)?;

    for (i, o) in objects.iter().enumerate() {
        // L'identifiant 1 est pris par les matériaux.
        write_mesh_object(&mut w, i as u32 + 2, &o.name, &o.tris, &color_id)?;
    }

    writeln!(w, " </resources>")?;
    writeln!(w, " <build>")?;
    for (i, o) in objects.iter().enumerate() {
        writeln!(
            w,
            r#"  <item objectid="{}" transform="{}"/>"#,
            i as u32 + 2,
            mat_str(&o.transform)
        )?;
    }
    writeln!(w, " </build>")?;
    writeln!(w, "</model>")?;
    w.flush()?;
    drop(w);

    // Réglages par objet lus par Orca et Bambu Studio : nom et tête affectée.
    z.start_file("Metadata/model_settings.config", opts)?;
    let mut s = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
    for (i, o) in objects.iter().enumerate() {
        s.push_str(&format!("  <object id=\"{}\">\n", i as u32 + 2));
        s.push_str(&format!(
            "    <metadata key=\"name\" value=\"{}\"/>\n",
            xml_escape(&o.name)
        ));
        if let Some(e) = o.extruder {
            s.push_str(&format!(
                "    <metadata key=\"extruder\" value=\"{}\"/>\n",
                e.clamp(1, 16)
            ));
        }
        s.push_str("  </object>\n");
    }
    s.push_str("</config>\n");
    z.write_all(s.as_bytes())?;

    z.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh;

    fn cube(size: f32, color: [u8; 3]) -> Vec<Tri> {
        let s = size;
        let p = [
            [0., 0., 0.], [s, 0., 0.], [s, s, 0.], [0., s, 0.],
            [0., 0., s], [s, 0., s], [s, s, s], [0., s, s],
        ];
        let faces = [
            [0, 2, 1], [0, 3, 2], // dessous
            [4, 5, 6], [4, 6, 7], // dessus
            [0, 1, 5], [0, 5, 4],
            [1, 2, 6], [1, 6, 5],
            [2, 3, 7], [2, 7, 6],
            [3, 0, 4], [3, 4, 7],
        ];
        faces
            .iter()
            .map(|f| Tri {
                v: [p[f[0]], p[f[1]], p[f[2]]],
                c: color,
            })
            .collect()
    }

    /// Ce que l'on écrit doit être relu à l'identique par notre propre lecteur.
    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join("snapstudio_w3mf");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scene.3mf");

        let mut place = Mat::IDENTITY;
        place.0[9] = 100.0; // translation en X du second cube
        place.0[10] = 50.0;
        let objects = vec![
            SceneObject {
                name: "cube rouge".into(),
                tris: cube(10.0, [200, 40, 40]),
                transform: Mat::IDENTITY,
                extruder: Some(1),
            },
            SceneObject {
                name: "cube bleu".into(),
                tris: cube(20.0, [40, 60, 200]),
                transform: place,
                extruder: Some(3),
            },
        ];
        write_scene(&path, &objects).unwrap();

        let mut zip = crate::model3mf::open(&path).unwrap();
        let m = mesh::load_mesh(&mut zip, 100_000).unwrap();
        assert_eq!(m.tris.len(), 24, "deux cubes de douze triangles");

        // Le second cube est bien déplacé : l'emprise va de 0 à 120 en X.
        assert!((m.min[0] - 0.0).abs() < 1e-4, "min x = {}", m.min[0]);
        assert!((m.max[0] - 120.0).abs() < 1e-4, "max x = {}", m.max[0]);
        assert!((m.max[1] - 70.0).abs() < 1e-4, "max y = {}", m.max[1]);

        // Les couleurs des matériaux survivent à l'aller-retour.
        assert!(m.tris.iter().any(|t| t.c == [200, 40, 40]));
        assert!(m.tris.iter().any(|t| t.c == [40, 60, 200]));

        // Les sommets sont partagés : huit par cube, pas trois par triangle.
        let data = std::fs::read(&path).unwrap();
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(data)).unwrap();
        let mut xml = String::new();
        z.by_name("3D/3dmodel.model")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert_eq!(xml.matches("<vertex ").count(), 16, "8 sommets par cube");
        assert!(xml.contains(r#"name="cube rouge""#));
        let mut cfg = String::new();
        z.by_name("Metadata/model_settings.config")
            .unwrap()
            .read_to_string(&mut cfg)
            .unwrap();
        assert!(cfg.contains(r#"key="extruder" value="3""#), "tête affectée");
    }

    /// Compose un plateau de deux exemplaires, pour l'essai de découpe réelle.
    #[test]
    fn dump_scene() {
        let (Ok(src), Ok(dst)) = (std::env::var("SCENE_SRC"), std::env::var("SCENE_OUT")) else {
            return;
        };
        let mut zip = crate::model3mf::open(Path::new(&src)).unwrap();
        let m = mesh::load_mesh(&mut zip, 2_000_000).unwrap();
        let size = m.size();
        // On repose la pièce à l'origine, puis on en pose deux côte à côte.
        let recenter = |dx: f32, dy: f32| {
            let mut t = Mat::IDENTITY;
            t.0[9] = -m.min[0] + dx;
            t.0[10] = -m.min[1] + dy;
            t.0[11] = -m.min[2];
            t
        };
        let objects = vec![
            SceneObject {
                name: "piece A".into(),
                tris: m.tris.clone(),
                transform: recenter(30.0, 30.0),
                extruder: Some(1),
            },
            SceneObject {
                name: "piece B".into(),
                tris: m.tris.clone(),
                transform: recenter(40.0 + size[0], 30.0),
                extruder: Some(2),
            },
        ];
        write_scene(Path::new(&dst), &objects).unwrap();
        println!(
            "écrit : {dst} ({} triangles par pièce, encombrement {:.1} x {:.1} mm)",
            m.tris.len(),
            size[0],
            size[1]
        );
    }

    /// Le fichier allégé doit garder sa géométrie et perdre ses réglages.
    #[test]
    fn strip_keeps_geometry() {
        let Ok(src) = std::env::var("STRIP_SRC") else {
            return;
        };
        let dst = std::env::temp_dir().join("snapstudio_stripped.3mf");
        let dropped = strip_project(Path::new(&src), &dst).unwrap();
        println!("entrées écartées : {dropped}");

        let mut a = crate::model3mf::open(Path::new(&src)).unwrap();
        let ma = mesh::load_mesh(&mut a, 2_000_000).unwrap();
        let mut b = crate::model3mf::open(&dst).unwrap();
        let mb = mesh::load_mesh(&mut b, 2_000_000).unwrap();
        assert_eq!(ma.tris.len(), mb.tris.len(), "même nombre de triangles");
        for k in 0..3 {
            assert!((ma.min[k] - mb.min[k]).abs() < 1e-4);
            assert!((ma.max[k] - mb.max[k]).abs() < 1e-4);
        }
        let names = crate::model3mf::entry_names(&b);
        assert!(
            !names.iter().any(|n| n.to_ascii_lowercase().contains("project_settings")),
            "les réglages de projet sont partis"
        );
        println!("{} entrées conservées", names.len());
    }
}
