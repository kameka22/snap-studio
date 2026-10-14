//! Interface language.
//!
//! The catalogs live in `ui/i18n/*.json` and are shared with the web UI: they
//! are compiled into the binary, used here for native menus and messages, and
//! injected into the main window before its scripts run (see `init_script`).
//!
//! Keys are flat and dotted (`menu.file.open`). A value is either a string or,
//! for plurals, an object keyed by `Intl.PluralRules` categories
//! (`{"one": "…", "other": "…"}`). Placeholders read `{name}`.
//!
//! English is the reference: a key missing from another catalog falls back to
//! it, then to the key itself.

use anyhow::{anyhow, Result};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

const EN: &str = include_str!("../../ui/i18n/en.json");
const FR: &str = include_str!("../../ui/i18n/fr.json");

/// Supported languages, in the order the pickers show them.
pub const LANGS: [&str; 2] = ["en", "fr"];

fn catalogs() -> &'static [(&'static str, Map<String, Value>)] {
    static C: OnceLock<Vec<(&'static str, Map<String, Value>)>> = OnceLock::new();
    C.get_or_init(|| {
        [("en", EN), ("fr", FR)]
            .into_iter()
            .map(|(l, raw)| {
                let v: Value = serde_json::from_str(raw).expect("invalid i18n catalog");
                (l, v.as_object().cloned().unwrap_or_default())
            })
            .collect()
    })
}

fn catalog(lang: &str) -> Option<&'static Map<String, Value>> {
    catalogs().iter().find(|(l, _)| *l == lang).map(|(_, m)| m)
}

// ------------------------------------------------------------ preference

fn settings_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio")
        .join("settings.json")
}

/// The language the user picked, if they ever did.
#[cfg_attr(test, allow(dead_code))]
fn stored() -> Option<String> {
    let raw = std::fs::read(settings_path()).ok()?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    let l = v.get("language")?.as_str()?.to_string();
    LANGS.contains(&l.as_str()).then_some(l)
}

/// The system language when we support it, English otherwise.
#[cfg_attr(test, allow(dead_code))]
fn system() -> String {
    let loc = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    let code = loc.split(['-', '_']).next().unwrap_or("");
    if LANGS.contains(&code) {
        code.to_string()
    } else {
        "en".into()
    }
}

fn current() -> &'static RwLock<String> {
    static L: OnceLock<RwLock<String>> = OnceLock::new();
    L.get_or_init(|| RwLock::new(initial()))
}

#[cfg(not(test))]
fn initial() -> String {
    stored().unwrap_or_else(system)
}

/// Tests read messages in English, whatever the machine they run on.
#[cfg(test)]
fn initial() -> String {
    "en".into()
}

pub fn lang() -> String {
    current().read().unwrap().clone()
}

/// Switches language and remembers the choice.
pub fn set(lang: &str) -> Result<()> {
    if !LANGS.contains(&lang) {
        return Err(anyhow!("unsupported language: {lang}"));
    }
    let path = settings_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let mut v: Value = std::fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()));
    v["language"] = Value::String(lang.into());
    std::fs::write(&path, serde_json::to_vec_pretty(&v)?)?;
    *current().write().unwrap() = lang.to_string();
    Ok(())
}

// ------------------------------------------------------------ lookup

fn lookup(lang: &str, key: &str) -> Option<&'static Value> {
    catalog(lang)
        .and_then(|m| m.get(key))
        .or_else(|| catalog("en").and_then(|m| m.get(key)))
}

/// English and French plural rules agree on what matters here, except for
/// zero, which French counts as singular.
fn plural_form(lang: &str, n: f64) -> &'static str {
    let one = if lang == "fr" { n < 2.0 } else { n == 1.0 };
    if one {
        "one"
    } else {
        "other"
    }
}

fn fill(mut s: String, params: &[(&str, String)]) -> String {
    for (k, v) in params {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

/// Translation of `key` in the current language.
pub fn t(key: &str) -> String {
    tf(key, &[])
}

/// Translation with placeholders; a numeric `n` also selects the plural form.
pub fn tf(key: &str, params: &[(&str, String)]) -> String {
    let lang = lang();
    let s = match lookup(&lang, key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(forms)) => {
            let n = params
                .iter()
                .find(|(k, _)| *k == "n")
                .and_then(|(_, v)| v.parse::<f64>().ok())
                .unwrap_or(0.0);
            forms
                .get(plural_form(&lang, n))
                .or_else(|| forms.get("other"))
                .and_then(Value::as_str)
                .unwrap_or(key)
                .to_string()
        }
        _ => key.to_string(),
    };
    fill(s, params)
}

/// `t!("key")` or `t!("key", name = value, …)`.
#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::i18n::t($key)
    };
    ($key:expr, $($name:ident = $value:expr),+ $(,)?) => {
        $crate::i18n::tf($key, &[$((stringify!($name), $value.to_string())),+])
    };
}

// ------------------------------------------------------------ web UI

/// Script run in the main window before any page script: the catalogs and
/// the current language, so the UI renders translated from its first frame.
pub fn init_script() -> String {
    format!(
        "window.__I18N__={{lang:{},catalogs:{{en:{},fr:{}}}}};",
        serde_json::to_string(&lang()).unwrap(),
        EN.trim(),
        FR.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogs_parse_and_share_their_keys() {
        let en = catalog("en").unwrap();
        let fr = catalog("fr").unwrap();
        let missing: Vec<_> = en.keys().filter(|k| !fr.contains_key(*k)).collect();
        assert!(missing.is_empty(), "missing from fr.json: {missing:?}");
        let extra: Vec<_> = fr.keys().filter(|k| !en.contains_key(*k)).collect();
        assert!(extra.is_empty(), "unknown to en.json: {extra:?}");
    }

    #[test]
    fn placeholders_and_plurals() {
        assert_eq!(fill("Saved: {name}".into(), &[("name", "a.3mf".into())]), "Saved: a.3mf");
        assert_eq!(plural_form("en", 0.0), "other");
        assert_eq!(plural_form("fr", 0.0), "one");
        assert_eq!(plural_form("fr", 1.0), "one");
        assert_eq!(plural_form("en", 2.0), "other");
        assert_eq!(t("no.such.key"), "no.such.key");
    }
}
