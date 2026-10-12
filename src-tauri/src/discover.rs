//! Recherche des imprimantes sur le réseau local (mDNS / Bonjour).
//!
//! Même méthode que Snapmaker Orca (`SSWCP.cpp`) : chaque U1 s'annonce sous
//! `_snapmaker._tcp.local`, avec une fiche TXT (`sn`, `device_name`,
//! `machine_type`, `version`, `ip`…). Une requête de réveil
//! `_services._dns-sd._udp` part d'abord : certains routeurs Wi-Fi ne relaient
//! le multicast qu'après en avoir vu passer. Les autres Klipper qui
//! s'annoncent (`_moonraker._tcp`) sont recherchés en même temps.
//!
//! Chaque imprimante résolue part aussitôt vers l'interface (`printer-found`),
//! la fin de la recherche est signalée par `printer-discover-done`.

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const WAKEUP: &str = "_services._dns-sd._udp.local.";
const SERVICES: &[(&str, &str)] = &[
    ("_snapmaker._tcp.local.", "snapmaker"),
    ("_moonraker._tcp.local.", "moonraker"),
];
/// Durée d'écoute, comme Orca.
const LISTEN: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Found {
    /// Numéro de série (U1), sinon absent.
    pub sn: Option<String>,
    pub name: String,
    pub model: Option<String>,
    pub ip: String,
    /// Port annoncé : celui du service, pas forcément celui de Moonraker.
    pub port: u16,
    pub firmware: Option<String>,
    /// « snapmaker » ou « moonraker ».
    pub service: String,
}

/// Recherche en cours : un drapeau pour l'arrêter.
#[derive(Default)]
pub struct Discovery(Mutex<Option<Arc<AtomicBool>>>);

impl Discovery {
    fn stop(&self) {
        if let Some(flag) = self.0.lock().unwrap().take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Lance une recherche ; une recherche précédente est arrêtée.
#[tauri::command]
pub fn printer_discover_start(app: AppHandle, state: State<'_, Discovery>) -> Result<(), String> {
    state.stop();
    let daemon = ServiceDaemon::new().map_err(|e| format!("recherche réseau indisponible : {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    *state.0.lock().unwrap() = Some(stop.clone());
    std::thread::spawn(move || {
        run(&daemon, &stop, |f| {
            log(&format!("{} — {} ({}, {})", f.service, f.name, f.ip, f.sn.as_deref().unwrap_or("sans n° de série")));
            let _ = app.emit("printer-found", f);
        });
        let _ = daemon.shutdown();
        let _ = app.emit("printer-discover-done", ());
    });
    Ok(())
}

#[tauri::command]
pub fn printer_discover_stop(state: State<'_, Discovery>) {
    state.stop();
}

/// Écoute jusqu'à la fin du délai ou l'arrêt demandé.
fn run(daemon: &ServiceDaemon, stop: &AtomicBool, mut on_found: impl FnMut(Found)) {
    // La réponse au réveil ne nous intéresse pas : seul compte le trafic
    // qu'elle provoque.
    let _wake = daemon.browse(WAKEUP);
    let receivers: Vec<_> = SERVICES
        .iter()
        .filter_map(|(ty, kind)| match daemon.browse(ty) {
            Ok(rx) => Some((rx, *kind)),
            Err(e) => {
                log(&format!("{ty} : {e}"));
                None
            }
        })
        .collect();
    let end = Instant::now() + LISTEN;
    while Instant::now() < end && !stop.load(Ordering::Relaxed) {
        let mut idle = true;
        for (rx, kind) in &receivers {
            while let Ok(ev) = rx.try_recv() {
                idle = false;
                if let ServiceEvent::ServiceResolved(s) = ev {
                    let txt = |k: &str| {
                        s.txt_properties
                            .get_property_val_str(k)
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .map(String::from)
                    };
                    let ips: Vec<_> = s.get_addresses_v4().into_iter().collect();
                    if let Some(f) = found(kind, &s.fullname, &s.host, s.port, &ips, txt) {
                        on_found(f);
                    }
                }
            }
        }
        if idle {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = daemon.stop_browse(WAKEUP);
    for (ty, _) in SERVICES {
        let _ = daemon.stop_browse(ty);
    }
}

/// Fiche d'une imprimante à partir d'une réponse mDNS ; IPv4 seulement.
fn found(
    kind: &str,
    fullname: &str,
    host: &str,
    port: u16,
    ips: &[std::net::Ipv4Addr],
    txt: impl Fn(&str) -> Option<String>,
) -> Option<Found> {
    // L'adresse annoncée dans la fiche passe avant celles de l'enregistrement :
    // c'est celle que l'imprimante dit utiliser.
    let ip = txt("ip")
        .filter(|v| v.parse::<std::net::Ipv4Addr>().is_ok())
        .or_else(|| {
            let mut v: Vec<_> = ips.iter().filter(|a| !a.is_loopback() && !a.is_link_local()).collect();
            v.sort();
            v.first().map(|a| a.to_string())
        })?;
    let instance = fullname.split("._").next().unwrap_or("").trim();
    let hostname = host.trim_end_matches('.').trim_end_matches(".local");
    let name = txt("device_name")
        .or_else(|| (!instance.is_empty()).then(|| instance.to_string()))
        .or_else(|| (!hostname.is_empty()).then(|| hostname.to_string()))
        .unwrap_or_else(|| ip.clone());
    Some(Found {
        sn: txt("sn"),
        name,
        model: txt("machine_type"),
        ip,
        port,
        firmware: txt("version"),
        service: kind.to_string(),
    })
}

fn log(msg: &str) {
    eprintln!("[discover] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::net::Ipv4Addr;

    fn txt(map: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = map.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn u1_from_txt_record() {
        let f = found(
            "snapmaker",
            "U1-4F2A._snapmaker._tcp.local.",
            "u1-4f2a.local.",
            8883,
            &[Ipv4Addr::new(192, 168, 1, 50)],
            txt(&[("sn", "SN123"), ("device_name", "Atelier"), ("machine_type", "Snapmaker U1"), ("version", "1.3.0")]),
        )
        .unwrap();
        assert_eq!(f.name, "Atelier");
        assert_eq!(f.ip, "192.168.1.50");
        assert_eq!(f.sn.as_deref(), Some("SN123"));
        assert_eq!(f.model.as_deref(), Some("Snapmaker U1"));
        assert_eq!(f.firmware.as_deref(), Some("1.3.0"));
    }

    #[test]
    fn falls_back_to_instance_and_skips_link_local() {
        let f = found(
            "moonraker",
            "voron._moonraker._tcp.local.",
            "voron.local.",
            7125,
            &[Ipv4Addr::new(169, 254, 3, 4), Ipv4Addr::new(10, 0, 0, 9)],
            txt(&[]),
        )
        .unwrap();
        assert_eq!(f.name, "voron");
        assert_eq!(f.ip, "10.0.0.9");
        assert_eq!(f.sn, None);
    }

    #[test]
    fn no_ipv4_no_printer() {
        assert!(found("snapmaker", "x._snapmaker._tcp.local.", "x.local.", 1, &[], txt(&[])).is_none());
    }

    /// Bout en bout sur la machine : une fausse U1 s'annonce, la recherche
    /// doit la trouver. Dépend du réseau (multicast) : lancé à la main.
    #[test]
    #[ignore]
    fn finds_an_announced_u1() {
        use mdns_sd::ServiceInfo;
        let host = ServiceDaemon::new().unwrap();
        let ip = local_ip();
        let info = ServiceInfo::new(
            "_snapmaker._tcp.local.",
            "U1-TEST",
            "u1-test.local.",
            ip.as_str(),
            8883,
            &[("sn", "SNTEST"), ("device_name", "U1 de test"), ("machine_type", "Snapmaker U1")][..],
        )
        .unwrap();
        host.register(info).unwrap();

        let daemon = ServiceDaemon::new().unwrap();
        let stop = AtomicBool::new(false);
        let mut hits = Vec::new();
        let t = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_secs(6));
                stop.store(true, Ordering::Relaxed);
            });
            run(&daemon, &stop, |f| hits.push(f));
        });
        let _ = t;
        println!("{hits:?}");
        assert!(hits.iter().any(|f| f.sn.as_deref() == Some("SNTEST") && f.name == "U1 de test"));
    }

    fn local_ip() -> String {
        let s = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        s.connect("192.0.2.1:9").unwrap();
        s.local_addr().unwrap().ip().to_string()
    }
}
