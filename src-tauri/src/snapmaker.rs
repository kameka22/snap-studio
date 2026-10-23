//! The Snapmaker hub's landing: a few products of the Store, from the
//! shop's public Shopify catalogue (`products.json`, `meta.json` for the
//! currency), picked for the U1 and kept an hour. Space has no public API
//! and its terms forbid crawling: nothing of it is read here.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const SHOP: &str = "https://shop.snapmaker.com";
const KEEP: Duration = Duration::from_secs(3600);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Product {
    pub title: String,
    /// The product's page on the shop.
    pub url: String,
    pub image: Option<String>,
    /// The first variant's price, as the shop writes it ("69.99").
    pub price: Option<String>,
    pub currency: String,
}

fn tags_of(p: &Value) -> String {
    match p.get("tags") {
        Some(Value::Array(a)) => a.iter().filter_map(|t| t.as_str()).collect::<Vec<_>>().join(" ").to_lowercase(),
        Some(Value::String(s)) => s.to_lowercase(),
        _ => String::new(),
    }
}

/// Available: a variant says so, or the catalogue does not say.
fn available(p: &Value) -> bool {
    match p.get("variants").and_then(|v| v.as_array()) {
        Some(vs) if !vs.is_empty() => vs.iter().any(|v| v.get("available").and_then(|a| a.as_bool()).unwrap_or(true)),
        _ => true,
    }
}

/// `limit` products for the landing: the available ones, those made for
/// the U1 first, then filaments, the rest in the catalogue's order (newest
/// first, as Shopify lists them).
pub fn pick(catalogue: &Value, currency: &str, limit: usize) -> Vec<Product> {
    let list = catalogue.get("products").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let mut rows: Vec<(i32, usize, Product)> = list
        .iter()
        .enumerate()
        .filter(|(_, p)| available(p))
        .filter_map(|(i, p)| {
            let title = p.get("title")?.as_str()?.trim().to_string();
            let handle = p.get("handle")?.as_str()?;
            let text = format!("{} {}", title.to_lowercase(), tags_of(p));
            let score = i32::from(text.contains("u1")) * 2 + i32::from(text.contains("filament"));
            let image = p
                .get("images")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .and_then(|im| im.get("src"))
                .and_then(|s| s.as_str())
                .map(String::from);
            let price = p
                .get("variants")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.get("price"))
                .and_then(|s| s.as_str())
                .map(String::from);
            Some((score, i, Product { title, url: format!("{SHOP}/products/{handle}"), image, price, currency: currency.to_string() }))
        })
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    rows.into_iter().take(limit).map(|(_, _, p)| p).collect()
}

fn cache() -> &'static Mutex<Option<(Instant, Vec<Product>)>> {
    static C: OnceLock<Mutex<Option<(Instant, Vec<Product>)>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// The landing's products, read from the shop at most once an hour.
pub async fn highlights(limit: usize) -> Result<Vec<Product>> {
    if let Some((at, list)) = cache().lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < KEEP {
            return Ok(list.iter().take(limit).cloned().collect());
        }
    }
    let client = crate::printers::client();
    let get = |url: String| async move {
        let r = client.get(&url).timeout(Duration::from_secs(12)).send().await?;
        if !r.status().is_success() {
            return Err(anyhow!("HTTP {}", r.status().as_u16()));
        }
        Ok::<Value, anyhow::Error>(r.json::<Value>().await?)
    };
    let currency = get(format!("{SHOP}/meta.json"))
        .await
        .ok()
        .and_then(|m| m.get("currency").and_then(|c| c.as_str()).map(String::from))
        .unwrap_or_else(|| "USD".into());
    let catalogue = get(format!("{SHOP}/products.json?limit=48")).await?;
    let list = pick(&catalogue, &currency, 12.max(limit));
    *cache().lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), list.clone()));
    Ok(list.into_iter().take(limit).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_u1_s_products_come_first_then_filaments_then_the_rest() {
        let cat = json!({ "products": [
            { "title": "Dry Box", "handle": "dry-box", "tags": ["Accessories"], "variants": [{ "price": "39.00", "available": true }], "images": [{ "src": "https://cdn/x.webp" }] },
            { "title": "PLA Bundle", "handle": "pla", "tags": "Filaments, PLA", "variants": [{ "price": "69.99", "available": true }] },
            { "title": "Sold Out Thing", "handle": "gone", "tags": [], "variants": [{ "price": "1.00", "available": false }] },
            { "title": "Nozzle Kit", "handle": "nozzle", "tags": ["Snapmaker U1"], "variants": [{ "price": "29.99", "available": true }] },
            { "title": "No variants", "handle": "nov", "tags": [] },
        ]});
        let got = pick(&cat, "USD", 10);
        let titles: Vec<&str> = got.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, ["Nozzle Kit", "PLA Bundle", "Dry Box", "No variants"]);
        assert_eq!(got[2].image.as_deref(), Some("https://cdn/x.webp"));
        assert_eq!(got[2].price.as_deref(), Some("39.00"));
        assert_eq!(got[2].url, "https://shop.snapmaker.com/products/dry-box");
        assert_eq!(got[3].price, None);
        assert_eq!(pick(&cat, "USD", 2).len(), 2);
        assert!(pick(&json!({}), "USD", 6).is_empty());
    }
}
