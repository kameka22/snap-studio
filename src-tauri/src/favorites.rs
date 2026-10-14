//! Favorites: models set aside from the Library.
//!
//! A remote web view has no bridge to the app: it cannot be asked for the
//! page title. So the URL is taken from the view, and the rest — title,
//! description, thumbnail — by reading the page again in Rust through its
//! `og:` tags, the very ones used for link previews.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Favorite {
    pub id: String,
    pub url: String,
    pub site: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// File name of the cached thumbnail, served by the `favimg` protocol.
    #[serde(default)]
    pub image: Option<String>,
    pub added_at: u64,
    #[serde(default)]
    pub done: bool,
}

fn dir() -> PathBuf {
    let d = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn store_path() -> PathBuf {
    dir().join("favorites.json")
}

pub fn images_dir() -> PathBuf {
    let d = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio")
        .join("favimg");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn list() -> Vec<Favorite> {
    let mut v: Vec<Favorite> = std::fs::read(store_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // To do first, then newest to oldest.
    v.sort_by(|a, b| a.done.cmp(&b.done).then(b.added_at.cmp(&a.added_at)));
    v
}

fn save(list: &[Favorite]) -> Result<()> {
    let tmp = store_path().with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(list)?)?;
    std::fs::rename(&tmp, store_path())?;
    Ok(())
}

pub fn remove(id: &str) -> Result<Vec<Favorite>> {
    let mut v = list();
    if let Some(f) = v.iter().find(|f| f.id == id) {
        if let Some(img) = &f.image {
            let _ = std::fs::remove_file(images_dir().join(img));
        }
    }
    v.retain(|f| f.id != id);
    save(&v)?;
    Ok(list())
}

pub fn set_done(id: &str, done: bool) -> Result<Vec<Favorite>> {
    let mut v = list();
    if let Some(f) = v.iter_mut().find(|f| f.id == id) {
        f.done = done;
    }
    save(&v)?;
    Ok(list())
}

/// Readable name of a site from its host.
fn site_name(host: &str) -> String {
    let h = host.trim_start_matches("www.").to_ascii_lowercase();
    match h.split('.').next().unwrap_or(&h) {
        "makerworld" => "MakerWorld".into(),
        "printables" => "Printables".into(),
        "thingiverse" => "Thingiverse".into(),
        "cults3d" => "Cults3D".into(),
        other => {
            let mut c = other.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => h.clone(),
            }
        }
    }
}

/// Last URL segment turned into a title: "1284937-vase-spirale" gives
/// "Vase spirale". Fallback when the page does not deliver its tags.
fn title_from_url(u: &url::Url) -> String {
    let seg = u
        .path_segments()
        .and_then(|s| s.filter(|x| !x.is_empty()).next_back())
        .unwrap_or("");
    let cleaned = seg
        .split('-')
        .filter(|p| !p.chars().all(|c| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ")
        .replace('_', " ");
    let t = cleaned.trim();
    if t.is_empty() {
        return u.host_str().unwrap_or("Model").to_string();
    }
    let mut c = t.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => t.to_string(),
    }
}

/// `<meta>` tags of a page, indexed by `property` or `name`.
///
/// An XML parser would reject real HTML; so the tags are scanned by hand,
/// which is plenty for simple attributes.
pub fn meta_tags(html: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    while let Some(p) = lower[i..].find("<meta") {
        let start = i + p;
        let Some(end_rel) = lower[start..].find('>') else { break };
        let tag = &html[start..start + end_rel];
        let attr = |name: &str| -> Option<String> {
            let l = tag.to_ascii_lowercase();
            let k = l.find(&format!("{name}="))?;
            let rest = &tag[k + name.len() + 1..];
            let quote = rest.chars().next()?;
            if quote != '"' && quote != '\'' {
                return None;
            }
            let body = &rest[1..];
            let stop = body.find(quote)?;
            Some(body[..stop].to_string())
        };
        if let (Some(key), Some(val)) = (
            attr("property").or_else(|| attr("name")),
            attr("content"),
        ) {
            out.entry(key.to_ascii_lowercase()).or_insert(val);
        }
        i = start + end_rel + 1;
    }
    out
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
             (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        )
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_default()
}

/// Adds a page to the favorites.
///
/// If the page cannot be read again — restricted access, anti-bot protection —
/// the favorite is still saved with a title derived from its address: better
/// an imperfect favorite than a lost one.
pub async fn add(url: &str) -> Result<Vec<Favorite>> {
    let parsed = url::Url::parse(url)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(anyhow!(crate::t!("err.fav_url")));
    }
    let mut v = list();
    if let Some(existing) = v.iter().find(|f| f.url == url) {
        return Err(anyhow!(crate::t!("err.fav_exists", name = existing.title)));
    }

    let id = format!(
        "{:x}",
        crate::util::fnv1a(&[url.as_bytes()])
    );
    let mut fav = Favorite {
        id: id.clone(),
        url: url.to_string(),
        site: site_name(parsed.host_str().unwrap_or("")),
        title: title_from_url(&parsed),
        description: String::new(),
        image: None,
        added_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        done: false,
    };

    if let Ok(resp) = client().get(url).send().await {
        if let Ok(html) = resp.text().await {
            let meta = meta_tags(&html);
            let pick = |keys: &[&str]| -> Option<String> {
                keys.iter()
                    .find_map(|k| meta.get(*k))
                    .map(|s| decode_entities(s.trim()))
                    .filter(|s| !s.is_empty())
            };
            if let Some(t) = pick(&["og:title", "twitter:title", "title"]) {
                fav.title = t;
            }
            if let Some(d) = pick(&["og:description", "description"]) {
                fav.description = d.chars().take(300).collect();
            }
            if let Some(s) = pick(&["og:site_name"]) {
                fav.site = s;
            }
            if let Some(img) = pick(&["og:image", "twitter:image"]) {
                if let Ok(abs) = parsed.join(&img) {
                    fav.image = fetch_image(&abs, &id).await;
                }
            }
        }
    }

    v.push(fav);
    save(&v)?;
    Ok(list())
}

/// Downloads the thumbnail and returns its cached file name.
async fn fetch_image(url: &url::Url, id: &str) -> Option<String> {
    let resp = client().get(url.clone()).send().await.ok()?;
    let ext = match resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
    {
        t if t.contains("png") => "png",
        t if t.contains("webp") => "webp",
        t if t.contains("gif") => "gif",
        _ => "jpg",
    };
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > 8 << 20 {
        return None;
    }
    let name = format!("{id}.{ext}");
    std::fs::write(images_dir().join(&name), &bytes).ok()?;
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_open_graph_tags() {
        let html = r#"<!doctype html><html><head>
            <meta charset="utf-8">
            <meta property="og:title" content="Vase spiralé &amp; léger">
            <meta property="og:image" content="/img/cover.jpg">
            <meta name="description" content="A pretty vase">
            <meta property="og:site_name" content='MakerWorld'>
        </head><body></body></html>"#;
        let m = meta_tags(html);
        assert_eq!(m.get("og:title").map(|s| decode_entities(s)).unwrap(), "Vase spiralé & léger");
        assert_eq!(m.get("og:image").unwrap(), "/img/cover.jpg");
        assert_eq!(m.get("description").unwrap(), "A pretty vase");
        assert_eq!(m.get("og:site_name").unwrap(), "MakerWorld", "single quotes accepted");
    }

    #[test]
    fn falls_back_on_the_url() {
        let u = url::Url::parse("https://makerworld.com/fr/models/1284937-vase-spirale").unwrap();
        assert_eq!(title_from_url(&u), "Vase spirale");
        assert_eq!(site_name(u.host_str().unwrap()), "MakerWorld");

        let p = url::Url::parse("https://www.printables.com/model/1234-support_telephone").unwrap();
        assert_eq!(title_from_url(&p), "Support telephone");
        assert_eq!(site_name(p.host_str().unwrap()), "Printables");

        // An address without a meaningful segment must not produce an empty title.
        let bare = url::Url::parse("https://makerworld.com/").unwrap();
        assert!(!title_from_url(&bare).is_empty());
    }

    #[test]
    fn store_round_trip() {
        let path = store_path();
        let backup = std::fs::read(&path).ok();
        let f = Favorite {
            id: "test-fav".into(),
            url: "https://example.com/x".into(),
            site: "Example".into(),
            title: "Part".into(),
            description: String::new(),
            image: None,
            added_at: 42,
            done: false,
        };
        let mut v = list();
        v.retain(|x| x.id != f.id);
        v.push(f);
        save(&v).unwrap();
        assert!(list().iter().any(|x| x.id == "test-fav"));
        let after = set_done("test-fav", true).unwrap();
        assert!(after.iter().find(|x| x.id == "test-fav").unwrap().done);
        let left = remove("test-fav").unwrap();
        assert!(!left.iter().any(|x| x.id == "test-fav"));

        match backup {
            Some(b) => std::fs::write(&path, b).unwrap(),
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}
