//! Lecture du conteneur 3MF : metadonnees, vignettes integrees, infos de decoupe.

use anyhow::{anyhow, Result};
use quick_xml::events::Event;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

pub type Zip = zip::ZipArchive<BufReader<File>>;

#[derive(Clone, Debug, Default)]
pub struct Filament {
    pub kind: String,
    pub color: Option<[u8; 3]>,
    pub used_g: Option<f32>,
    pub used_m: Option<f32>,
}

#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub title: Option<String>,
    pub designer: Option<String>,
    pub license: Option<String>,
    pub description: Option<String>,
    pub application: Option<String>,
    pub creation_date: Option<String>,
    pub object_names: Vec<String>,
    /// Duree estimee de la premiere plaque, en secondes.
    pub print_time_s: Option<u32>,
    pub weight_g: Option<f32>,
    pub filaments: Vec<Filament>,
    pub plates: usize,
    pub printer: Option<String>,
    pub has_embedded_thumb: bool,
}

/// D'ou vient l'image affichee.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThumbSource {
    Plate,
    Model,
    Rendered,
    None,
}

/// Preference d'aperçu choisie par l'utilisateur.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThumbPref {
    /// Vignette integree si elle existe, sinon rendu du maillage.
    Auto,
    /// Priorite a l'apercu de plateau du slicer.
    Plate,
    /// Priorite a la photo / image du modele.
    Model,
    /// Toujours rendre la geometrie.
    Render,
}

impl ThumbPref {
    pub fn tag(self) -> u8 {
        match self {
            ThumbPref::Auto => 0,
            ThumbPref::Plate => 1,
            ThumbPref::Model => 2,
            ThumbPref::Render => 3,
        }
    }
}

pub fn open(path: &Path) -> Result<Zip> {
    let f = File::open(path)?;
    let z = zip::ZipArchive::new(BufReader::new(f))?;
    Ok(z)
}

pub fn read_entry(zip: &mut Zip, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::with_capacity(f.size().min(64 << 20) as usize);
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

pub fn entry_names(zip: &Zip) -> Vec<String> {
    zip.file_names().map(|s| s.to_string()).collect()
}

fn is_image(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".png") || l.ends_with(".jpg") || l.ends_with(".jpeg") || l.ends_with(".webp")
}

/// Note chaque image du conteneur ; la meilleure sert de vignette.
fn score_image(name: &str, pref: ThumbPref) -> i32 {
    let l = name.to_ascii_lowercase();
    if !is_image(&l) {
        return -1;
    }
    // Images techniques inutilisables comme apercu.
    if l.contains("pick_") || l.contains("no_light") || l.contains("/top_") || l.starts_with("top_")
    {
        return -1;
    }
    if l.contains("designercover") || l.contains("profile pictures/") {
        return -1;
    }
    let plate = if l == "metadata/plate_1.png" {
        100
    } else if l == "metadata/thumbnail.png" || l == "thumbnail.png" {
        98
    } else if l.starts_with("metadata/plate_") {
        90
    } else if l.contains("thumbnail") && l.contains("metadata/") {
        88
    } else {
        0
    };
    let model = if l.contains(".thumbnails/thumbnail_middle") {
        100
    } else if l.contains(".thumbnails/thumbnail_3mf") {
        92
    } else if l.contains(".thumbnails/") {
        85
    } else if l.contains("model pictures/") {
        80
    } else {
        0
    };
    match pref {
        ThumbPref::Model => {
            if model > 0 {
                model + 50
            } else {
                plate
            }
        }
        _ => {
            if plate > 0 {
                plate + 50
            } else {
                model
            }
        }
    }
    .max(if plate == 0 && model == 0 { 10 } else { 0 })
}

/// Renvoie (nom de l'entree, octets) de la meilleure vignette integree.
pub fn find_thumbnail(zip: &mut Zip, pref: ThumbPref) -> Option<(String, Vec<u8>, ThumbSource)> {
    let mut best: Option<(i32, String)> = None;
    for name in entry_names(zip) {
        let s = score_image(&name, pref);
        if s <= 0 {
            continue;
        }
        if best.as_ref().map(|(bs, _)| s > *bs).unwrap_or(true) {
            best = Some((s, name));
        }
    }
    let (_, name) = best?;
    let src = if name.to_ascii_lowercase().contains("metadata/") {
        ThumbSource::Plate
    } else {
        ThumbSource::Model
    };
    let data = read_entry(zip, &name)?;
    Some((name, data, src))
}

/// Valeur d'attribut avec references d'entites resolues.
pub fn aval<'a>(a: &quick_xml::events::attributes::Attribute<'a>) -> std::borrow::Cow<'a, str> {
    a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
        .unwrap_or_else(|_| a.value.clone())
}

fn attr_str(e: &quick_xml::events::BytesStart, key: &str) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == key {
            return Some(aval(&a).to_string());
        }
    }
    None
}

/// Lit l'entete de 3D/3dmodel.model : metadonnees + noms d'objets (les maillages sont sautes).
fn read_model_header(zip: &mut Zip, meta: &mut Meta) -> Result<()> {
    let f = zip
        .by_name("3D/3dmodel.model")
        .map_err(|_| anyhow!("3dmodel.model absent"))?;
    let mut reader = quick_xml::Reader::from_reader(BufReader::new(f));
    reader.config_mut().trim_text(true);
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::new();
    let mut cur_key: Option<String> = None;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "metadata" => cur_key = attr_str(&e, "name"),
                "object" => {
                    if let Some(n) = attr_str(&e, "name") {
                        if !n.is_empty() && meta.object_names.len() < 64 {
                            meta.object_names.push(n);
                        }
                    }
                }
                // Les gros blocs sont sautes sans interpretation.
                "vertices" | "triangles" => {
                    let name = e.name().into_inner().to_string();
                    let mut skip = Vec::new();
                    let _ = reader.read_to_end_into(quick_xml::name::QName(&name), &mut skip);
                }
                _ => {}
            },
            Ok(Event::Text(t)) => {
                if let Some(k) = cur_key.take() {
                    let v = t.xml_content(quick_xml::XmlVersion::Implicit1_0).to_string();
                    if v.is_empty() {
                        continue;
                    }
                    match k.as_str() {
                        "Title" => meta.title = Some(v),
                        "Designer" => meta.designer = Some(v),
                        "License" | "LicenseType" => meta.license = Some(v),
                        "Description" => meta.description = Some(crate::util::strip_html(&v)),
                        "Application" => meta.application = Some(v),
                        "CreationDate" => meta.creation_date = Some(v),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(_)) => cur_key = None,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(())
}

fn parse_color(s: &str) -> Option<[u8; 3]> {
    let s = s.trim().trim_start_matches('#');
    if s.len() < 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some([r, g, b])
}

/// Metadata/slice_info.config (Bambu / Orca) : duree, poids, filaments.
fn read_slice_info(zip: &mut Zip, meta: &mut Meta) {
    let Some(data) = read_entry(zip, "Metadata/slice_info.config") else {
        return;
    };
    let mut reader = quick_xml::Reader::from_reader(data.as_slice());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut first_plate = true;
    loop {
        let ev = reader.read_event_into(&mut buf);
        match ev {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "plate" => {
                    meta.plates += 1;
                    first_plate = meta.plates == 1;
                }
                "metadata" if first_plate => {
                    let k = attr_str(&e, "key").unwrap_or_default();
                    let v = attr_str(&e, "value").unwrap_or_default();
                    match k.as_str() {
                        "prediction" => meta.print_time_s = v.parse().ok(),
                        "weight" => meta.weight_g = v.parse().ok(),
                        "printer_model_id" => meta.printer = Some(v),
                        _ => {}
                    }
                }
                "filament" if first_plate => {
                    meta.filaments.push(Filament {
                        kind: attr_str(&e, "type").unwrap_or_else(|| "?".into()),
                        color: attr_str(&e, "color").as_deref().and_then(parse_color),
                        used_g: attr_str(&e, "used_g").and_then(|s| s.parse().ok()),
                        used_m: attr_str(&e, "used_m").and_then(|s| s.parse().ok()),
                    });
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
}

/// Metadata/model_settings.config (Bambu) : noms d'objets reels.
fn read_model_settings(zip: &mut Zip, meta: &mut Meta) {
    let Some(data) = read_entry(zip, "Metadata/model_settings.config") else {
        return;
    };
    let mut reader = quick_xml::Reader::from_reader(data.as_slice());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut names = Vec::new();
    let mut in_object = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "object" => in_object = true,
                "part" => in_object = false,
                "metadata" if in_object => {
                    if attr_str(&e, "key").as_deref() == Some("name") {
                        if let Some(v) = attr_str(&e, "value") {
                            if !v.is_empty() && names.len() < 64 {
                                names.push(v);
                            }
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) if e.local_name().as_ref() == "object" => in_object = false,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    if !names.is_empty() {
        meta.object_names = names;
    }
}

/// Extrudeur affecté à chaque objet de la scène, et à chacune de ses pièces.
///
/// `Metadata/model_settings.config` (Bambu, Orca) : `<object id>` désigne
/// l'objet du `<build>`, `<part id>` le composant ; la valeur `extruder` part
/// de 1, et 0 ou l'absence signifie « comme l'objet ».
pub fn extruder_settings(zip: &mut Zip) -> HashMap<u32, (u8, HashMap<u32, u8>)> {
    let mut out: HashMap<u32, (u8, HashMap<u32, u8>)> = HashMap::new();
    let Some(data) = read_entry(zip, "Metadata/model_settings.config") else {
        return out;
    };
    let mut reader = quick_xml::Reader::from_reader(data.as_slice());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut object: Option<u32> = None;
    let mut part: Option<u32> = None;
    loop {
        let ev = reader.read_event_into(&mut buf);
        // Une balise auto-fermante n'a pas de contenu : elle n'ouvre rien.
        let opens = matches!(ev, Ok(Event::Start(_)));
        match ev {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "object" => {
                    object = attr_str(&e, "id").and_then(|v| v.parse().ok()).filter(|_| opens);
                    part = None;
                }
                "part" => {
                    let pid: Option<u32> = attr_str(&e, "id").and_then(|v| v.parse().ok());
                    // Toute pièce est connue, même sans extrudeur déclaré (0 :
                    // celui de l'objet) ; seule une balise ouvrante attend du contenu.
                    if let (Some(o), Some(id)) = (object, pid) {
                        out.entry(o).or_insert((0, HashMap::new())).1.entry(id).or_insert(0);
                    }
                    part = pid.filter(|_| opens);
                }
                "metadata" if attr_str(&e, "key").as_deref() == Some("extruder") => {
                    let ext: u8 = attr_str(&e, "value").and_then(|v| v.parse().ok()).unwrap_or(0);
                    if let Some(o) = object {
                        let entry = out.entry(o).or_insert((0, HashMap::new()));
                        match part {
                            Some(pid) => {
                                entry.1.insert(pid, ext);
                            }
                            None => entry.0 = ext,
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "part" => part = None,
                "object" => object = None,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Nom et plateau de chaque objet du `<build>`, d'après
/// `model_settings.config` (Bambu, Orca). Plateau 1 par défaut.
pub fn object_settings(zip: &mut Zip) -> (HashMap<u32, String>, HashMap<u32, u32>) {
    let mut names = HashMap::new();
    let mut plates = HashMap::new();
    let Some(data) = read_entry(zip, "Metadata/model_settings.config") else {
        return (names, plates);
    };
    let mut reader = quick_xml::Reader::from_reader(data.as_slice());
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    // Contexte : objet (hors pièce) ou plateau en cours de lecture.
    let mut object: Option<u32> = None;
    let mut in_part = false;
    let mut plate: Option<u32> = None;
    let mut in_plate = false;
    let mut plate_objects: Vec<u32> = Vec::new();
    loop {
        let ev = reader.read_event_into(&mut buf);
        let opens = matches!(ev, Ok(Event::Start(_)));
        match ev {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "object" if opens => {
                    object = attr_str(&e, "id").and_then(|v| v.parse().ok());
                    in_part = false;
                }
                "part" if opens => in_part = true,
                "plate" if opens => {
                    in_plate = true;
                    plate = None;
                    plate_objects.clear();
                }
                "metadata" => {
                    let key = attr_str(&e, "key").unwrap_or_default();
                    let val = attr_str(&e, "value").unwrap_or_default();
                    if in_plate {
                        match key.as_str() {
                            "plater_id" => plate = val.parse().ok(),
                            "object_id" => {
                                if let Ok(id) = val.parse() {
                                    plate_objects.push(id);
                                }
                            }
                            _ => {}
                        }
                    } else if let (Some(o), false, "name") = (object, in_part, key.as_str()) {
                        if !val.is_empty() {
                            names.insert(o, val);
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "part" => in_part = false,
                "object" => object = None,
                "plate" => {
                    if let Some(p) = plate {
                        for id in plate_objects.drain(..) {
                            plates.insert(id, p);
                        }
                    }
                    in_plate = false;
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    (names, plates)
}

/// Un filament déclaré par le projet (`project_settings.config`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProjectFilament {
    /// Numéro d'extrudeur du modèle, à partir de 1.
    pub index: u8,
    pub kind: String,
    pub color: Option<String>,
}

/// Filaments du projet : matière et couleur de chaque extrudeur du modèle.
pub fn project_filaments(zip: &mut Zip) -> Vec<ProjectFilament> {
    let Some(data) = read_entry(zip, "Metadata/project_settings.config") else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&data) else {
        return Vec::new();
    };
    let list = |k: &str| -> Vec<String> {
        v.get(k)
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default()
    };
    let (types, colors) = (list("filament_type"), list("filament_colour"));
    (0..types.len().max(colors.len()).min(16))
        .map(|i| ProjectFilament {
            index: i as u8 + 1,
            kind: types.get(i).cloned().unwrap_or_default(),
            color: colors.get(i).map(|c| c.chars().take(7).collect::<String>().to_lowercase()),
        })
        .collect()
}

/// Lecture complete des metadonnees d'un fichier 3MF.
pub fn read_meta(zip: &mut Zip) -> Meta {
    let mut meta = Meta::default();
    meta.has_embedded_thumb = entry_names(zip)
        .iter()
        .any(|n| score_image(n, ThumbPref::Auto) > 0);
    let _ = read_model_header(zip, &mut meta);
    read_slice_info(zip, &mut meta);
    read_model_settings(zip, &mut meta);
    meta
}
