//! Plugins (API v1, `docs/plans/plugin-api-v1.md`): the built-in plugins
//! shipped in `ui/plugins/`, their manifests checked, and one JSON store
//! per plugin in the app's folder (`plugins/<id>.json`).
//!
//! The loader (`ui/plugins.js`) checks each host call against the
//! manifest's permissions; the commands here do not know yet which plugin
//! calls them (that comes with the sandbox of user plugins). What they do
//! check: a store's id is a plugin of the index, written so it cannot leave
//! the `plugins` folder, and a store stays under its size limit.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// The API version this app runs.
pub const API: u64 = 1;
/// What a plugin may ask for.
const PERMISSIONS: [&str; 3] = ["printer.read", "storage", "open.url"];
/// Where a plugin may show.
const CONTRIBUTIONS: [&str; 5] = ["tabs", "actions", "badges", "schedules", "snappy"];
/// A plugin's store, at most.
pub const STORE_MAX: usize = 1024 * 1024;
/// The Care plugin, which takes over the maintenance log.
pub const CARE: &str = "snapstudio.care";

/// The built-in plugins, shipped with the interface.
const INDEX: &str = include_str!("../../ui/plugins/index.json");

#[derive(Deserialize, Clone, Debug)]
pub struct Builtin {
    pub id: String,
    pub dir: String,
}

#[derive(Deserialize, Debug)]
struct Index {
    builtin: Vec<Builtin>,
}

fn builtins_of(index: &str) -> Vec<Builtin> {
    serde_json::from_str::<Index>(index).map(|i| i.builtin).unwrap_or_default()
}

pub fn builtins() -> Vec<Builtin> {
    builtins_of(INDEX)
}

/// `snapstudio.care`: lowercase letters and digits, then one or more
/// `.part` with letters, digits and `-`. No `/`, no `..`: it names a file.
pub fn valid_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let first = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    let ok = |s: &str, dash: bool| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || (dash && b == b'-'));
    id.len() <= 64 && ok(first, false) && !rest.is_empty() && rest.iter().all(|s| ok(s, true))
}

/// A key in a store: `log`, `cache`, `last.tab`…
fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 64 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// What is wrong with a manifest, if anything: the loader then leaves the
/// plugin off, with this line in the log.
pub fn check(m: &Value, id: &str) -> Result<(), String> {
    let s = |k: &str| m.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    match s("id") {
        None => return Err("no id".into()),
        Some(x) if x != id => return Err(format!("id {x} is not the index's {id}")),
        Some(_) => {}
    }
    match m.get("api").and_then(Value::as_u64) {
        Some(API) => {}
        Some(v) => return Err(format!("api {v} is not supported (this app runs api {API})")),
        None => return Err("no api".into()),
    }
    for k in ["version", "name", "entry"] {
        if s(k).is_none() {
            return Err(format!("no {k}"));
        }
    }
    if s("kind") != Some("builtin") {
        return Err("only built-in plugins run in this version".into());
    }
    let entry = s("entry").unwrap_or("");
    if !entry.ends_with(".js") || entry.contains('/') || entry.contains('\\') || entry.starts_with('.') {
        return Err(format!("entry {entry} must be a .js file next to the manifest"));
    }
    let perms = m.get("permissions").map(|p| p.as_array().ok_or("permissions is not a list")).transpose()?;
    for p in perms.into_iter().flatten() {
        let p = p.as_str().unwrap_or("");
        if !PERMISSIONS.contains(&p) {
            return Err(format!("unknown permission {p:?}"));
        }
    }
    if let Some(c) = m.get("contributes") {
        let c = c.as_object().ok_or("contributes is not an object")?;
        for (kind, list) in c {
            if !CONTRIBUTIONS.contains(&kind.as_str()) {
                return Err(format!("unknown contribution {kind:?}"));
            }
            if !list.is_array() {
                return Err(format!("{kind} is not a list"));
            }
        }
    }
    Ok(())
}

/// A built-in plugin as the loader gets it: its manifest, or why it is off.
#[derive(Serialize, Debug)]
pub struct Found {
    pub id: String,
    pub dir: String,
    pub manifest: Option<Value>,
    pub error: Option<String>,
}

/// The built-ins and their manifests, read with `read` (the app's assets).
pub fn found(read: impl Fn(&str) -> Option<Vec<u8>>) -> Vec<Found> {
    builtins()
        .into_iter()
        .map(|b| {
            let m = read(&format!("plugins/{}/plugin.json", b.dir))
                .ok_or_else(|| "no plugin.json".to_string())
                .and_then(|d| serde_json::from_slice::<Value>(&d).map_err(|e| format!("plugin.json: {e}")))
                .and_then(|m| check(&m, &b.id).map(|_| m));
            match m {
                Ok(m) => Found { id: b.id, dir: b.dir, manifest: Some(m), error: None },
                Err(e) => Found { id: b.id, dir: b.dir, manifest: None, error: Some(e) },
            }
        })
        .collect()
}

// ------------------------------------------------------------ storage

/// `plugins/<id>.json` in `dir`, for a plugin of the index only.
pub fn store_file(dir: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        bail!("{id:?} is not a plugin id");
    }
    if !builtins().iter().any(|b| b.id == id) {
        bail!("{id} is not a known plugin");
    }
    Ok(dir.join("plugins").join(format!("{id}.json")))
}

/// A plugin's store; the first time Care reads its own, the maintenance log
/// of earlier versions (`maintenance.json`) becomes its `log`. That file is
/// left as it was, and never read again.
fn read_store(dir: &Path, id: &str) -> Result<Map<String, Value>> {
    let path = store_file(dir, id)?;
    match std::fs::read(&path) {
        Ok(d) => return serde_json::from_slice(&d).with_context(|| format!("reading {}", path.display())),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e).with_context(|| format!("reading {}", path.display())),
        Err(_) => {}
    }
    let mut store = Map::new();
    if id == CARE {
        let old = std::fs::read(dir.join("maintenance.json")).ok().and_then(|d| serde_json::from_slice::<Value>(&d).ok());
        if let Some(log) = old.filter(Value::is_object) {
            store.insert("log".into(), log);
        }
        write_store(&path, &store)?;
    }
    Ok(store)
}

fn write_store(path: &Path, store: &Map<String, Value>) -> Result<()> {
    let bytes = serde_json::to_vec(store)?;
    if bytes.len() > STORE_MAX {
        bail!("the plugin's data would be over {} KB", STORE_MAX / 1024);
    }
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
    crate::util::write_atomic(path, &bytes)
}

pub fn get_in(dir: &Path, id: &str, key: &str) -> Result<Value> {
    if !valid_key(key) {
        bail!("{key:?} is not a storage key");
    }
    Ok(read_store(dir, id)?.remove(key).unwrap_or(Value::Null))
}

/// Sets a key; `null` removes it.
pub fn set_in(dir: &Path, id: &str, key: &str, value: Value) -> Result<()> {
    if !valid_key(key) {
        bail!("{key:?} is not a storage key");
    }
    let mut store = read_store(dir, id)?;
    if value.is_null() {
        store.remove(key);
    } else {
        store.insert(key.to_string(), value);
    }
    write_store(&store_file(dir, id)?, &store)
}

pub fn get(id: &str, key: &str) -> Result<Value> {
    get_in(&crate::util::app_dir(), id, key)
}

pub fn set(id: &str, key: &str, value: Value) -> Result<()> {
    set_in(&crate::util::app_dir(), id, key, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn care() -> Value {
        serde_json::from_str(include_str!("../../ui/plugins/care/plugin.json")).unwrap()
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snapstudio_plugins_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_index_lists_care_and_its_manifest_is_valid() {
        let b = builtins();
        assert!(b.iter().any(|b| b.id == CARE && b.dir == "care"));
        assert_eq!(check(&care(), CARE), Ok(()));
        assert!(builtins_of("not json").is_empty());
    }

    #[test]
    fn ids_cannot_leave_the_plugins_folder() {
        for ok in ["snapstudio.care", "a.b", "org.my-plugin.x2"] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "care", "../x", "a/b", "a..b", "a.", ".a", "A.b", "a.b/../c", "snapstudio.care\\x", "a-b.c", "a.b c"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_bad_manifest_is_refused_with_a_reason() {
        let with = |k: &str, v: Value| {
            let mut m = care();
            m[k] = v;
            check(&m, CARE).unwrap_err()
        };
        assert!(with("api", json!(2)).contains("api 2"));
        assert!(with("id", json!("snapstudio.other")).contains("index"));
        assert!(with("kind", json!("user")).contains("built-in"));
        assert!(with("entry", json!("../app.js")).contains("entry"));
        assert!(with("entry", json!("main.css")).contains("entry"));
        assert!(with("permissions", json!(["printer.write"])).contains("printer.write"));
        assert!(with("contributes", json!({ "panels": [] })).contains("panels"));
        let mut m = care();
        m.as_object_mut().unwrap().remove("version");
        assert_eq!(check(&m, CARE).unwrap_err(), "no version");
        assert_eq!(check(&json!(null), CARE).unwrap_err(), "no id");
    }

    #[test]
    fn found_reports_a_missing_or_broken_manifest() {
        let ok = found(|p| (p == "plugins/care/plugin.json").then(|| include_bytes!("../../ui/plugins/care/plugin.json").to_vec()));
        assert!(ok[0].manifest.is_some() && ok[0].error.is_none());
        let none = found(|_| None);
        assert_eq!(none[0].error.as_deref(), Some("no plugin.json"));
        let broken = found(|_| Some(b"{".to_vec()));
        assert!(broken[0].error.as_deref().unwrap().starts_with("plugin.json"));
    }

    #[test]
    fn each_plugin_has_its_own_store() {
        let dir = temp("store");
        assert_eq!(get_in(&dir, CARE, "log").unwrap(), Value::Null);
        set_in(&dir, CARE, "cache", json!({ "u1": { "at": 1 } })).unwrap();
        assert_eq!(get_in(&dir, CARE, "cache").unwrap()["u1"]["at"], 1);
        assert!(dir.join("plugins/snapstudio.care.json").exists());
        set_in(&dir, CARE, "cache", Value::Null).unwrap();
        assert_eq!(get_in(&dir, CARE, "cache").unwrap(), Value::Null);
        // Ids and keys refused: never a path outside `plugins/`.
        for id in ["../x", "a/b", "snapstudio.unknown"] {
            assert!(get_in(&dir, id, "log").is_err(), "{id}");
            assert!(set_in(&dir, id, "log", json!(1)).is_err(), "{id}");
        }
        assert!(set_in(&dir, CARE, "../k", json!(1)).is_err());
        assert!(get_in(&dir, CARE, "").is_err());
    }

    #[test]
    fn a_store_has_a_size_limit() {
        let dir = temp("limit");
        let big = "x".repeat(STORE_MAX);
        assert!(set_in(&dir, CARE, "big", json!(big)).unwrap_err().to_string().contains("1024 KB"));
        // Nothing written over the limit; what was there stays.
        set_in(&dir, CARE, "small", json!(1)).unwrap();
        assert!(set_in(&dir, CARE, "big", json!(big)).is_err());
        assert_eq!(get_in(&dir, CARE, "small").unwrap(), 1);
    }

    #[test]
    fn care_takes_over_the_maintenance_log_once() {
        let log = json!({ "u1": [{ "task": "contacts", "at": 10, "print_hours": 500.0, "swaps": [1, 2] }] });
        // Present: imported, and the old file left as it was.
        let dir = temp("import");
        std::fs::write(dir.join("maintenance.json"), log.to_string()).unwrap();
        assert_eq!(get_in(&dir, CARE, "log").unwrap(), log);
        assert_eq!(std::fs::read_to_string(dir.join("maintenance.json")).unwrap(), log.to_string());
        // Never again: a log changed afterwards is not overwritten.
        set_in(&dir, CARE, "log", json!({})).unwrap();
        assert_eq!(get_in(&dir, CARE, "log").unwrap(), json!({}));
        // Absent: an empty store.
        let dir = temp("import_none");
        assert_eq!(get_in(&dir, CARE, "log").unwrap(), Value::Null);
        assert!(dir.join("plugins/snapstudio.care.json").exists());
        // Corrupt: nothing imported, no error, the old file kept.
        let dir = temp("import_corrupt");
        std::fs::write(dir.join("maintenance.json"), "{ not json").unwrap();
        assert_eq!(get_in(&dir, CARE, "log").unwrap(), Value::Null);
        assert!(dir.join("maintenance.json").exists());
        // A store already there: the old file is not read.
        let dir = temp("import_after");
        set_in(&dir, CARE, "cache", json!(1)).unwrap();
        std::fs::write(dir.join("maintenance.json"), log.to_string()).unwrap();
        assert_eq!(get_in(&dir, CARE, "log").unwrap(), Value::Null);
    }

    #[test]
    fn a_corrupt_store_is_an_error_not_an_empty_one() {
        // Read as empty, the next write would lose what it held.
        let dir = temp("corrupt");
        std::fs::create_dir_all(dir.join("plugins")).unwrap();
        std::fs::write(dir.join("plugins/snapstudio.care.json"), "{").unwrap();
        assert!(get_in(&dir, CARE, "log").is_err());
        assert!(set_in(&dir, CARE, "log", json!({})).is_err());
    }
}
