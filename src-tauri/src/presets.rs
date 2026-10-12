//! Préréglages de Snapmaker Orca : inventaire, résolution de l'héritage, et
//! écriture de configurations complètes pour le moteur de découpe.
//!
//! Les préréglages livrés avec l'application et ceux de l'utilisateur ne sont
//! que des différentiels : chacun porte un `inherits` vers un parent. Le moteur
//! en ligne de commande, lui, refuse tout ce qui n'est pas complet — il exige
//! aussi les champs `type` et `from`, absents des préréglages utilisateur.
//!
//! Deux pièges découverts à l'usage, corrigés ici :
//!
//! * `normalize_fdm` lit `wipe_tower_filament` (préréglage process) et
//!   `nozzle_diameter` (préréglage machine) **dans le même objet** ; si le
//!   second manque, le moteur déréférence un pointeur nul et meurt. On recopie
//!   donc `nozzle_diameter` dans la configuration process.
//! * les filaments compatibles avec la buse 0.4 n'ont aucun suffixe dans leur
//!   nom : il faut les filtrer sur `compatible_printers`, jamais sur le nom.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Machine,
    Process,
    Filament,
}

impl Kind {
    fn dir(self) -> &'static str {
        match self {
            Kind::Machine => "machine",
            Kind::Process => "process",
            Kind::Filament => "filament",
        }
    }
    fn tag(self) -> &'static str {
        self.dir()
    }
}

struct Entry {
    kind: Kind,
    json: Value,
    user: bool,
}

pub struct Index {
    entries: HashMap<String, Entry>,
    /// Préréglages sélectionnés dans Snapmaker Orca, s'ils sont lisibles.
    pub selected: HashMap<String, String>,
}

/// Clés de gestion des préréglages, sans intérêt pour l'utilisateur.
const META: &[&str] = &["name", "type", "from", "inherits", "instantiation", "setting_id", "filament_id", "version", "is_custom_defined"];

/// Contenu d'un préréglage pour la fenêtre de détail.
#[derive(Serialize, Debug)]
pub struct Details {
    pub name: String,
    pub kind: Kind,
    pub user: bool,
    /// Du préréglage vers ses ancêtres.
    pub chain: Vec<String>,
    /// Valeurs effectives : héritage résolu, ajouts de Snap Studio compris.
    pub values: Map<String, Value>,
    /// Réglages modifiés par Snap Studio pour cette découpe.
    pub snap: Vec<String>,
    /// Préréglage personnel : réglages qui diffèrent du préréglage système.
    pub custom: Vec<String>,
}

/// Ce que Snap Studio ajoute au préréglage d'impression : le plateau (par
/// défaut celui de la machine), puis les surcharges de l'utilisateur.
pub fn process_extra(index: &Index, machine: &str, overrides: &Map<String, Value>) -> Map<String, Value> {
    let (_, bed) = index.bed_types(machine);
    let mut out = Map::new();
    out.insert("curr_bed_type".into(), Value::String(bed));
    for (k, v) in overrides {
        out.insert(k.clone(), v.clone());
    }
    out
}

/// Ce que Snap Studio ajoute à un préréglage filament : la couleur réelle de
/// la bobine.
pub fn filament_extra(color: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(c) = color.filter(|c| is_hex_color(c)) {
        out.insert("filament_colour".into(), Value::Array(vec![Value::String(c.to_uppercase())]));
    }
    out
}

/// Type de plateau : valeur attendue par le moteur, libellé affiché.
#[derive(Serialize, Clone, Debug)]
pub struct BedType {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Clone)]
pub struct PresetDto {
    pub name: String,
    pub kind: Kind,
    /// Vrai pour un préréglage créé par l'utilisateur.
    pub user: bool,
    /// Filaments seulement : matière (`PLA`, `PETG`…) et fabricant, pour
    /// retrouver le préréglage qui correspond à une bobine chargée.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// Dossier de données de Snapmaker Orca.
pub fn datadir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Snapmaker_Orca")
}

/// Dossier des profils livrés avec l'application.
fn system_profiles(app: &Path) -> Option<PathBuf> {
    crate::slicers::resources(app).map(|r| r.join("profiles/Snapmaker"))
}

impl Index {
    /// Inventorie les profils système de `app` et les préréglages de l'utilisateur.
    pub fn build(app: &Path) -> Result<Index> {
        let Some(sys) = system_profiles(app).filter(|p| p.is_dir()) else {
            return Err(anyhow!(
                "profils introuvables dans {} — cette application n'est pas Snapmaker Orca",
                app.display()
            ));
        };
        let mut entries = HashMap::new();
        let add = |dir: PathBuf, kind: Kind, user: bool, entries: &mut HashMap<String, Entry>| {
            let Ok(rd) = std::fs::read_dir(&dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let Some(json) = read_json(&p) else { continue };
                let name = json
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| p.file_stem().unwrap_or_default().to_string_lossy().to_string());
                // Un préréglage utilisateur masque celui du système de même nom.
                if user || !entries.contains_key(&name) {
                    entries.insert(name, Entry { kind, json, user });
                }
            }
        };
        for kind in [Kind::Machine, Kind::Process, Kind::Filament] {
            add(sys.join(kind.dir()), kind, false, &mut entries);
        }
        let ud = datadir().join("user/default");
        for kind in [Kind::Machine, Kind::Process, Kind::Filament] {
            add(ud.join(kind.dir()), kind, true, &mut entries);
        }

        Ok(Index {
            entries,
            selected: read_selected(),
        })
    }

    /// Configuration complète d'un préréglage, héritage résolu.
    pub fn flatten(&self, name: &str) -> Option<Map<String, Value>> {
        self.flatten_inner(name, &mut HashSet::new(), 0)
    }

    fn flatten_inner(&self, name: &str, seen: &mut HashSet<String>, depth: u32) -> Option<Map<String, Value>> {
        if depth > 16 || !seen.insert(name.to_string()) {
            return None;
        }
        let e = self.entries.get(name)?;
        let obj = e.json.as_object()?;
        let mut out = match obj.get("inherits").and_then(|v| v.as_str()) {
            Some(parent) if !parent.is_empty() => {
                self.flatten_inner(parent, seen, depth + 1).unwrap_or_default()
            }
            _ => Map::new(),
        };
        for (k, v) in obj {
            if k == "inherits" || k == "from" {
                continue;
            }
            out.insert(k.clone(), v.clone());
        }
        Some(out)
    }

    pub fn kind_of(&self, name: &str) -> Option<Kind> {
        self.entries.get(name).map(|e| e.kind)
    }

    /// Chaîne d'héritage, du préréglage vers ses ancêtres.
    pub fn chain(&self, name: &str) -> Vec<String> {
        let mut out = vec![];
        let mut cur = Some(name.to_string());
        while let Some(n) = cur.take() {
            if out.contains(&n) || out.len() > 16 {
                break;
            }
            cur = self
                .entries
                .get(&n)
                .and_then(|e| e.json.get("inherits"))
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
                .map(String::from);
            out.push(n);
        }
        out
    }

    /// Contenu d'un préréglage tel qu'il part au moteur : héritage résolu,
    /// puis `extra`, ce que Snap Studio y ajoute pour cette découpe.
    pub fn details(&self, name: &str, extra: &Map<String, Value>) -> Option<Details> {
        let e = self.entries.get(name)?;
        let mut values = self.flatten(name)?;
        let mut snap = vec![];
        for (k, v) in extra {
            if values.get(k) != Some(v) {
                snap.push(k.clone());
            }
            values.insert(k.clone(), v.clone());
        }
        let chain = self.chain(name);
        // Préréglage personnel : ce qui diffère de son premier ancêtre système.
        let custom = chain
            .iter()
            .skip(1)
            .find(|n| self.entries.get(*n).is_some_and(|x| !x.user))
            .filter(|_| e.user)
            .and_then(|base| self.flatten(base))
            .map(|base| {
                let own = self.flatten(name).unwrap_or_default();
                own.iter()
                    .filter(|(k, v)| base.get(*k) != Some(*v) && !META.contains(&k.as_str()))
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default();
        for k in META {
            values.remove(*k);
        }
        Some(Details { name: name.to_string(), kind: e.kind, user: e.user, chain, values, snap, custom })
    }

    /// Préréglages d'un type donné, proposables à l'utilisateur.
    fn selectable(&self, kind: Kind) -> Vec<(&String, &Entry)> {
        self.entries
            .iter()
            .filter(|(_, e)| e.kind == kind)
            .filter(|(_, e)| {
                e.user
                    || e.json.get("instantiation").and_then(|v| v.as_str()) == Some("true")
            })
            .collect()
    }

    pub fn machines(&self) -> Vec<PresetDto> {
        let mut v: Vec<PresetDto> = self
            .selectable(Kind::Machine)
            .into_iter()
            .map(|(n, e)| PresetDto { name: n.clone(), kind: Kind::Machine, user: e.user, ftype: None, vendor: None })
            .collect();
        sort_presets(&mut v);
        v
    }

    /// La machine choisie et ses ancêtres.
    ///
    /// Un préréglage machine personnel hérite du profil système, et les listes
    /// `compatible_printers` citent le nom du parent : sans cette remontée, un
    /// profil personnalisé n'aurait aucun process ni filament compatible.
    fn machine_aliases(&self, machine: &str) -> Vec<String> {
        let mut out = vec![machine.to_string()];
        let mut cur = machine.to_string();
        for _ in 0..16 {
            let Some(parent) = self
                .entries
                .get(&cur)
                .and_then(|e| e.json.get("inherits"))
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
            else {
                break;
            };
            out.push(parent.to_string());
            cur = parent.to_string();
        }
        out
    }

    /// Préréglages compatibles avec une machine donnée.
    fn compatible(&self, kind: Kind, machine: &str) -> Vec<PresetDto> {
        let names = self.machine_aliases(machine);
        let mut v: Vec<PresetDto> = self
            .selectable(kind)
            .into_iter()
            .filter_map(|(n, e)| {
                // La compatibilité peut être déclarée sur le préréglage lui-même
                // ou héritée de son parent ; l'héritage résolu sert aussi à lire
                // la matière et le fabricant d'un filament.
                let flat = self.flatten(n).unwrap_or_default();
                let ok = match flat.get("compatible_printers").and_then(|v| v.as_array()) {
                    Some(list) if !list.is_empty() => list
                        .iter()
                        .any(|x| x.as_str().map(|s| names.iter().any(|n| n == s)).unwrap_or(false)),
                    // Sans liste explicite, le préréglage vaut pour tout le monde.
                    _ => true,
                };
                if !ok {
                    return None;
                }
                let (ftype, vendor) = if kind == Kind::Filament {
                    (first_str(&flat, "filament_type"), first_str(&flat, "filament_vendor"))
                } else {
                    (None, None)
                };
                Some(PresetDto { name: n.clone(), kind, user: e.user, ftype, vendor })
            })
            .collect();
        sort_presets(&mut v);
        v
    }

    pub fn processes_for(&self, machine: &str) -> Vec<PresetDto> {
        self.compatible(Kind::Process, machine)
    }

    pub fn filaments_for(&self, machine: &str) -> Vec<PresetDto> {
        self.compatible(Kind::Filament, machine)
    }

    /// Dimensions utiles du plateau, en millimètres.
    pub fn plate_size(&self, machine: &str) -> (f32, f32) {
        let corners = self
            .flatten(machine)
            .and_then(|m| m.get("printable_area").and_then(|v| v.as_array()).cloned())
            .unwrap_or_default();
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for c in corners {
            // Format « 270.5x271 ».
            let Some((a, b)) = c.as_str().and_then(|s| s.split_once('x')) else {
                continue;
            };
            let (Ok(x), Ok(y)) = (a.trim().parse::<f32>(), b.trim().parse::<f32>()) else {
                continue;
            };
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
        }
        if x1 > x0 && y1 > y0 {
            (x1 - x0, y1 - y0)
        } else {
            (256.0, 256.0)
        }
    }

    /// Modèle d'imprimante d'un préréglage machine (« Snapmaker U1 »…).
    pub fn printer_model(&self, machine: &str) -> Option<String> {
        self.flatten(machine)?
            .get("printer_model")?
            .as_str()
            .filter(|s| !s.is_empty())
            .map(String::from)
    }

    /// Plateaux proposés pour une machine, et celui par défaut.
    ///
    /// La température du plateau dépend du plateau choisi : chaque profil
    /// filament en porte une par type (`textured_plate_temp`,
    /// `cool_plate_temp`…). Sans `curr_bed_type`, le moteur prend la Cool
    /// Plate — 35 °C pour le PLA de la U1, au lieu de 65 °C.
    pub fn bed_types(&self, machine: &str) -> (Vec<BedType>, String) {
        let cfg = self.flatten(machine).unwrap_or_default();
        let u1 = cfg
            .get("printer_model")
            .and_then(|v| v.as_str())
            .is_some_and(|m| m.contains("U1"));
        // Mêmes listes que l'interface d'Orca (`PrintConfig.cpp`).
        let list: &[(&str, &str)] = if u1 {
            &[
                ("Textured PEI Plate", "PEI texturé"),
                ("High Temp Plate", "PEI lisse"),
                ("Graphic Effect Plate", "Plateau à effet graphique"),
            ]
        } else {
            &[
                ("Textured PEI Plate", "PEI texturé"),
                ("High Temp Plate", "PEI lisse (High Temp)"),
                ("Cool Plate", "Cool Plate lisse"),
                ("Textured Cool Plate", "Cool Plate texturé"),
                ("Engineering Plate", "Engineering Plate"),
                ("Supertack Plate", "Cool Plate (SuperTack)"),
            ]
        };
        let types: Vec<BedType> = list
            .iter()
            .map(|(value, label)| BedType { value: value.to_string(), label: label.to_string() })
            .collect();
        let default = cfg
            .get("default_bed_type")
            .and_then(|v| v.as_str())
            .filter(|d| types.iter().any(|t| t.value == *d))
            .unwrap_or(list[0].0)
            .to_string();
        (types, default)
    }

    /// Nombre de têtes déclarées par une machine.
    pub fn extruder_count(&self, machine: &str) -> usize {
        self.flatten(machine)
            .and_then(|m| {
                m.get("nozzle_diameter")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
            })
            .unwrap_or(1)
            .max(1)
    }
}

/// Les préréglages utilisateur d'abord, puis par ordre alphabétique naturel.
/// Première valeur d'un réglage, qu'il soit écrit en liste ou en texte.
fn first_str(cfg: &Map<String, Value>, key: &str) -> Option<String> {
    let v = cfg.get(key)?;
    let s = match v {
        Value::Array(a) => a.first()?.as_str()?.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn sort_presets(v: &mut [PresetDto]) {
    v.sort_by(|a, b| b.user.cmp(&a.user).then_with(|| a.name.cmp(&b.name)));
}

/// Préréglages actuellement sélectionnés dans Snapmaker Orca.
fn read_selected() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let p = datadir().join("Snapmaker_Orca.conf");
    let Some(v) = read_json(&p) else { return out };
    if let Some(presets) = v.get("presets").and_then(|p| p.as_object()) {
        for (k, val) in presets {
            if let Some(s) = val.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

/// Fichiers de configuration prêts pour le moteur de découpe.
pub struct Prepared {
    pub machine: PathBuf,
    pub process: PathBuf,
    pub filaments: Vec<PathBuf>,
}

/// Déclare la machine dans `compatible_printers`.
///
/// Le moteur vérifie la compatibilité sur le **nom** du préréglage machine. Un
/// préréglage personnel s'appelle « … LCA » alors que les process listent le
/// nom du parent : sans cet ajout, il répond « process not compatible with
/// printer » et s'arrête.
fn declare_compatible(cfg: &mut Map<String, Value>, machine: &str) {
    let Some(list) = cfg.get_mut("compatible_printers").and_then(|v| v.as_array_mut()) else {
        return; // sans liste, le préréglage vaut déjà pour toutes les machines
    };
    if !list.iter().any(|x| x.as_str() == Some(machine)) {
        list.push(Value::String(machine.to_string()));
    }
}

/// `#rrggbb` : seule forme acceptée pour une couleur de filament.
fn is_hex_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

fn write_config(dir: &Path, kind: Kind, name: &str, mut cfg: Map<String, Value>, suffix: &str) -> Result<PathBuf> {
    cfg.insert("type".into(), Value::String(kind.tag().into()));
    cfg.insert("name".into(), Value::String(name.into()));
    // Le moteur n'accepte que « system » ou « User » ; nos fichiers sont des
    // configurations complètes, pas des différentiels d'utilisateur.
    cfg.insert("from".into(), Value::String("system".into()));
    cfg.insert("instantiation".into(), Value::String("true".into()));
    let path = dir.join(format!("{}{}.json", kind.dir(), suffix));
    std::fs::write(&path, serde_json::to_vec_pretty(&Value::Object(cfg))?)?;
    Ok(path)
}

/// Écrit les configurations complètes dans `dir`.
///
/// `filaments` contient un préréglage par tête ; s'il en manque, le premier est
/// répété, comme le fait l'interface d'Orca. `colors` porte la couleur réelle
/// de chaque bobine : elle remplace celle du préréglage, et se retrouve dans le
/// G-code et l'aperçu.
pub fn prepare(
    index: &Index,
    dir: &Path,
    machine: &str,
    process: &str,
    filaments: &[String],
    colors: &[Option<String>],
    overrides: &Map<String, Value>,
) -> Result<Prepared> {
    std::fs::create_dir_all(dir)?;
    if index.kind_of(machine) != Some(Kind::Machine) {
        return Err(anyhow!("préréglage machine inconnu : {machine}"));
    }
    if index.kind_of(process) != Some(Kind::Process) {
        return Err(anyhow!("préréglage d'impression inconnu : {process}"));
    }
    let machine_cfg = index
        .flatten(machine)
        .ok_or_else(|| anyhow!("héritage irrésoluble pour {machine}"))?;
    let mut process_cfg = index
        .flatten(process)
        .ok_or_else(|| anyhow!("héritage irrésoluble pour {process}"))?;

    // Sans cette recopie, `normalize_fdm` cherche `nozzle_diameter` à côté de
    // `wipe_tower_filament` et tombe sur un pointeur nul.
    if let Some(nd) = machine_cfg.get("nozzle_diameter") {
        process_cfg.insert("nozzle_diameter".into(), nd.clone());
    }
    // Plateau par défaut de la machine ; le choix de l'utilisateur, passé
    // dans `overrides`, l'emporte.
    for (k, v) in process_extra(index, machine, overrides) {
        process_cfg.insert(k, v);
    }
    declare_compatible(&mut process_cfg, machine);

    let machine_path = write_config(dir, Kind::Machine, machine, machine_cfg, "")?;
    let process_path = write_config(dir, Kind::Process, process, process_cfg, "")?;

    let count = index.extruder_count(machine);
    let mut paths = Vec::new();
    for i in 0..count {
        let name = filaments
            .get(i)
            .or_else(|| filaments.first())
            .ok_or_else(|| anyhow!("aucun filament choisi"))?;
        if index.kind_of(name) != Some(Kind::Filament) {
            return Err(anyhow!("préréglage de filament inconnu : {name}"));
        }
        let mut cfg = index
            .flatten(name)
            .ok_or_else(|| anyhow!("héritage irrésoluble pour {name}"))?;
        declare_compatible(&mut cfg, machine);
        for (k, v) in filament_extra(colors.get(i).and_then(|c| c.as_deref())) {
            cfg.insert(k, v);
        }
        paths.push(write_config(dir, Kind::Filament, name, cfg, &format!("_{i}"))?);
    }

    Ok(Prepared {
        machine: machine_path,
        process: process_path,
        filaments: paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> PathBuf {
        PathBuf::from("/Applications/Snapmaker Orca.app")
    }

    fn index() -> Option<Index> {
        if !app().is_dir() {
            return None;
        }
        Index::build(&app()).ok()
    }

    #[test]
    fn user_machine_inherits_compatibility() {
        let Some(idx) = index() else { return };
        let Some(user_machine) = idx.machines().into_iter().find(|m| m.user) else {
            return;
        };
        let procs = idx.processes_for(&user_machine.name);
        let fils = idx.filaments_for(&user_machine.name);
        println!(
            "préréglage personnel « {} » : {} process, {} filaments",
            user_machine.name,
            procs.len(),
            fils.len()
        );
        assert!(!procs.is_empty(), "les process du parent restent compatibles");
        assert!(!fils.is_empty(), "les filaments du parent restent compatibles");
    }

    #[test]
    fn indexes_and_resolves() {
        let Some(idx) = index() else { return };
        let machines = idx.machines();
        println!("{} machines proposables", machines.len());
        let u1 = machines
            .iter()
            .find(|m| m.name == "Snapmaker U1 (0.4 nozzle)")
            .expect("la U1 0.4 est proposée");
        println!("sélection courante : {:?}", idx.selected.get("machine"));

        let flat = idx.flatten(&u1.name).unwrap();
        assert!(flat.len() > 50, "configuration complète ({} clés)", flat.len());
        assert!(flat.contains_key("nozzle_diameter"));
        assert!(flat.contains_key("machine_start_gcode"), "hérité du parent");
        assert!(!flat.contains_key("inherits"), "l'héritage est résolu");
        assert_eq!(idx.extruder_count(&u1.name), 4, "la U1 a quatre têtes");

        let procs = idx.processes_for(&u1.name);
        let fils = idx.filaments_for(&u1.name);
        println!("{} process, {} filaments compatibles", procs.len(), fils.len());
        assert!(!procs.is_empty() && !fils.is_empty());
        // Le piège du nommage : les filaments de la buse 0.4 n'ont pas de suffixe.
        assert!(
            fils.iter().any(|f| f.name.contains("PLA")),
            "au moins un PLA compatible"
        );
        assert!(
            !fils.iter().any(|f| f.name.contains("0.2 nozzle")),
            "aucun filament d'une autre buse"
        );
    }

    /// Profils du clone de référence d'OrcaSlicer, s'il est là (non versionné).
    fn repo_index() -> Option<Index> {
        let readme = Path::new(env!("CARGO_MANIFEST_DIR")).join("../OrcaSlicer/README.md");
        readme.is_file().then(|| Index::build(&readme).ok()).flatten()
    }

    /// Le détail affiché est exactement ce que reçoit le moteur.
    #[test]
    fn details_match_what_the_engine_gets() {
        let Some(idx) = repo_index().or_else(index) else { return };
        let machine = "Snapmaker U1 (0.4 nozzle)";
        let process = idx.processes_for(machine)[0].name.clone();
        let filament = idx.filaments_for(machine).into_iter().find(|f| f.name.contains("PLA")).unwrap().name;
        let mut over = Map::new();
        over.insert("curr_bed_type".into(), "High Temp Plate".into());
        over.insert("wall_loops".into(), "5".into());

        let d = idx.details(&process, &process_extra(&idx, machine, &over)).unwrap();
        assert_eq!(d.kind, Kind::Process);
        assert!(d.chain.len() > 1, "héritage : {:?}", d.chain);
        assert!(d.snap.contains(&"curr_bed_type".to_string()));
        assert!(!d.values.contains_key("inherits"), "clés de gestion retirées");

        let dir = std::env::temp_dir().join("snapstudio_details_test");
        let p = prepare(&idx, &dir, machine, &process, &[filament.clone()], &[Some("#ff8800".into())], &over).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&p.process).unwrap()).unwrap();
        for k in ["curr_bed_type", "wall_loops", "layer_height", "sparse_infill_density"] {
            assert_eq!(written.get(k), d.values.get(k), "{k}");
        }
        let f = idx.details(&filament, &filament_extra(Some("#ff8800"))).unwrap();
        let fw: Value = serde_json::from_slice(&std::fs::read(&p.filaments[0]).unwrap()).unwrap();
        assert_eq!(fw["filament_colour"], f.values["filament_colour"]);
        assert_eq!(fw["hot_plate_temp"], f.values["hot_plate_temp"]);
        println!("{} : {:?} · plateau {} → {}", process, d.chain, d.values["curr_bed_type"], f.values["hot_plate_temp"]);
    }

    #[test]
    fn prepares_complete_configs() {
        let Some(idx) = index() else { return };
        let machine = "Snapmaker U1 (0.4 nozzle)";
        let process = idx.processes_for(machine)[0].name.clone();
        let filament = idx.filaments_for(machine)[0].name.clone();
        let dir = std::env::temp_dir().join("snapstudio_presets_test");
        let _ = std::fs::remove_dir_all(&dir);

        let p = prepare(&idx, &dir, machine, &process, &[filament.clone()], &[], &Map::new()).unwrap();
        assert_eq!(p.filaments.len(), 4, "un filament par tête");

        let m: Value = serde_json::from_slice(&std::fs::read(&p.machine).unwrap()).unwrap();
        assert_eq!(m["type"], "machine");
        assert_eq!(m["from"], "system");
        let pr: Value = serde_json::from_slice(&std::fs::read(&p.process).unwrap()).unwrap();
        assert_eq!(pr["type"], "process");
        assert!(
            pr.get("nozzle_diameter").is_some(),
            "nozzle_diameter recopié : c'est ce qui évite le plantage"
        );
        assert_eq!(pr["curr_bed_type"], "Textured PEI Plate", "plateau par défaut de la U1");
        println!("process « {process} », filament « {filament} » → {}", dir.display());
    }

    /// Le moteur de découpe doit accepter ce que l'on écrit : on le lance pour
    /// de bon sur un modèle et on attend un G-code.
    #[test]
    fn engine_accepts_prepared_configs() {
        let (Some(idx), Ok(model)) = (index(), std::env::var("SLICE_MODEL")) else {
            return;
        };
        // On part des préréglages réellement sélectionnés dans Orca.
        let machine = idx
            .selected
            .get("machine")
            .cloned()
            .filter(|m| idx.kind_of(m) == Some(Kind::Machine))
            .unwrap_or_else(|| "Snapmaker U1 (0.4 nozzle)".into());
        let process = idx
            .selected
            .get("print")
            .cloned()
            .filter(|p| idx.kind_of(p) == Some(Kind::Process))
            .unwrap_or_else(|| idx.processes_for(&machine)[0].name.clone());
        let filament = idx
            .filaments_for(&machine)
            .iter()
            .find(|f| f.name.contains("PLA"))
            .map(|f| f.name.clone())
            .unwrap_or_else(|| idx.filaments_for(&machine)[0].name.clone());

        let dir = std::env::temp_dir().join("snapstudio_slice_it");
        let _ = std::fs::remove_dir_all(&dir);
        let p = prepare(&idx, &dir, &machine, &process, &[filament.clone()], &[], &Map::new()).unwrap();

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let settings = format!("{};{}", p.machine.display(), p.process.display());
        let fils = p
            .filaments
            .iter()
            .map(|f| f.display().to_string())
            .collect::<Vec<_>>()
            .join(";");
        let t = std::time::Instant::now();
        let out_cmd = std::process::Command::new(crate::slicers::executable(&app()).unwrap())
            .args(["--arrange", "0", "--allow-newer-file", "--slice", "0"])
            .arg("--load-settings").arg(&settings)
            .arg("--load-filaments").arg(&fils)
            .arg("--outputdir").arg(&out)
            .arg(&model)
            .output()
            .expect("moteur lançable");
        let status = out_cmd.status;
        let mut msg = String::from_utf8_lossy(&out_cmd.stdout).to_string();
        msg.push_str(&String::from_utf8_lossy(&out_cmd.stderr));
        let tail: Vec<&str> = msg
            .lines()
            .filter(|l| !l.contains("sentry") && !l.contains("StaticPrintConfigs"))
            .rev()
            .take(4)
            .collect();
        println!("moteur : {:?}", tail);

        let produced: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("gcode"))
            .collect();
        println!(
            "machine « {machine} »\nprocess « {process} »\nfilament « {filament} »\n→ code {:?} en {} ms, {} fichier(s) : {:?}",
            status.code(),
            t.elapsed().as_millis(),
            produced.len(),
            produced.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect::<Vec<_>>()
        );
        assert!(status.success(), "le moteur a refusé la configuration");
        assert!(!produced.is_empty(), "aucun G-code produit");
        let size = std::fs::metadata(&produced[0]).unwrap().len();
        assert!(size > 1000, "G-code trop court ({size} octets)");
    }

    #[test]
    fn applies_overrides() {
        let Some(idx) = index() else { return };
        let machine = "Snapmaker U1 (0.4 nozzle)";
        let process = idx.processes_for(machine)[0].name.clone();
        let filament = idx.filaments_for(machine)[0].name.clone();
        let dir = std::env::temp_dir().join("snapstudio_presets_ovr");
        let mut ovr = Map::new();
        ovr.insert("layer_height".into(), Value::String("0.28".into()));
        let p = prepare(&idx, &dir, machine, &process, &[filament], &[], &ovr).unwrap();
        let pr: Value = serde_json::from_slice(&std::fs::read(&p.process).unwrap()).unwrap();
        assert_eq!(pr["layer_height"], "0.28");
    }
}
