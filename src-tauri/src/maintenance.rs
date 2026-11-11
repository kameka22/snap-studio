//! Printer maintenance: the counters the printer keeps.
//!
//! The Snapmaker U1 counts, per head, its tool changes (`switch_count`), the
//! count at the last maintenance confirmed on its screen
//! (`last_maintenance_count`), and its tool change errors and retries;
//! Moonraker's history keeps the jobs, print hours and filament. Nothing
//! resets the printer's maintenance count from outside: what was done is
//! logged by the Care plugin (`ui/plugins/care`), in its own store, with the
//! counters at that moment. Read only — nothing is written to the printer.

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

/// One head, as the printer counts it.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Head {
    pub index: u8,
    pub switch_count: u64,
    pub last_maintenance_count: u64,
    pub retry_count: u64,
    pub error_count: u64,
    /// `standard` or `high_flow` (U1).
    pub nozzle: Option<String>,
    pub diameter: Option<f64>,
}

/// What a printer reports about its use.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub jobs: u64,
    pub print_hours: f64,
    pub total_hours: f64,
    pub filament_m: f64,
    pub longest_print_hours: f64,
    /// Heads with counters (U1); empty on another Klipper printer.
    pub heads: Vec<Head>,
    pub purifier_hours: Option<f64>,
}

const HEADS: [&str; 4] = ["extruder", "extruder1", "extruder2", "extruder3"];

fn u64_of(v: &Value) -> u64 {
    v.as_f64().map(|x| x.max(0.0) as u64).unwrap_or(0)
}

/// Usage from Moonraker's answers: the objects query (`result.status`) and
/// the history totals (`result.job_totals`).
pub fn parse(status: &Value, totals: &Value) -> Usage {
    let t = &totals["job_totals"];
    let heads = HEADS
        .iter()
        .enumerate()
        .filter_map(|(i, name)| {
            let h = status.get(*name)?;
            // An ordinary extruder has none of the U1's counters.
            h.get("switch_count")?;
            Some(Head {
                index: i as u8,
                switch_count: u64_of(&h["switch_count"]),
                last_maintenance_count: u64_of(&h["last_maintenance_count"]),
                retry_count: u64_of(&h["retry_count"]),
                error_count: u64_of(&h["error_count"]),
                nozzle: h["nozzle_volume_type"].as_str().map(String::from),
                diameter: h["nozzle_diameter"].as_f64(),
            })
        })
        .collect();
    Usage {
        jobs: u64_of(&t["total_jobs"]),
        print_hours: t["total_print_time"].as_f64().unwrap_or(0.0) / 3600.0,
        total_hours: t["total_time"].as_f64().unwrap_or(0.0) / 3600.0,
        filament_m: t["total_filament_used"].as_f64().unwrap_or(0.0) / 1000.0,
        longest_print_hours: t["longest_print"].as_f64().unwrap_or(0.0) / 3600.0,
        heads,
        purifier_hours: status["purifier"]["inner_fan_work_time"].as_f64().map(|s| s / 3600.0),
    }
}

/// Reads the counters and the history totals of a printer.
pub async fn usage(host: &str, port: u16) -> Result<Usage> {
    let base = crate::printers::base(host, port);
    let objects =
        crate::printers::get_json(&format!("{base}/printer/objects/query?extruder&extruder1&extruder2&extruder3&purifier")).await?;
    // A printer without the history component still has its counters.
    let totals = crate::printers::get_json(&format!("{base}/server/history/totals")).await.unwrap_or(Value::Null);
    Ok(parse(&objects["result"]["status"], &totals["result"]))
}

/// A printer's job count and print hours (Moonraker's history only): the
/// bed mesh's "measurement due" reminder counts prints with it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Totals {
    pub jobs: u64,
    pub print_hours: f64,
}

pub async fn totals(host: &str, port: u16) -> Result<Totals> {
    let base = crate::printers::base(host, port);
    let t = crate::printers::get_json(&format!("{base}/server/history/totals")).await?;
    let u = parse(&Value::Null, &t["result"]);
    Ok(Totals { jobs: u.jobs, print_hours: u.print_hours })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a real U1's answers (firmware 1.3, Moonraker 2.0).
    fn u1() -> (Value, Value) {
        let status = serde_json::json!({
            "extruder": { "temperature": 31.0, "nozzle_diameter": 0.4, "nozzle_volume_type": "standard",
                          "switch_count": 1604, "retry_count": 2, "error_count": 0, "last_maintenance_count": 0 },
            "extruder1": { "nozzle_diameter": 0.4, "nozzle_volume_type": "standard",
                           "switch_count": 1439, "retry_count": 0, "error_count": 0, "last_maintenance_count": 0 },
            "extruder2": { "nozzle_diameter": 0.4, "nozzle_volume_type": "standard",
                           "switch_count": 922, "retry_count": 0, "error_count": 0, "last_maintenance_count": 0 },
            "extruder3": { "nozzle_diameter": 0.4, "nozzle_volume_type": "high_flow",
                           "switch_count": 1589, "retry_count": 0, "error_count": 7, "last_maintenance_count": 0 },
            "purifier": { "inner_fan_work_time": 7200.0 }
        });
        let totals = serde_json::json!({ "job_totals": {
            "total_jobs": 373.0, "total_time": 2059620.9, "total_print_time": 1964679.5,
            "total_filament_used": 4693090.0, "longest_job": 35036.9, "longest_print": 34815.0
        }});
        (status, totals)
    }

    #[test]
    fn a_u1_reports_its_heads_and_hours() {
        let (status, totals) = u1();
        let u = parse(&status, &totals);
        assert_eq!(u.jobs, 373);
        assert!((u.print_hours - 545.74).abs() < 0.01, "{}", u.print_hours);
        assert!((u.filament_m - 4693.09).abs() < 0.01);
        assert!((u.longest_print_hours - 9.67).abs() < 0.01);
        assert_eq!(u.purifier_hours, Some(2.0));
        assert_eq!(u.heads.len(), 4);
        assert_eq!(u.heads[0].switch_count, 1604);
        assert_eq!(u.heads[0].retry_count, 2);
        assert_eq!((u.heads[3].error_count, u.heads[3].nozzle.as_deref()), (7, Some("high_flow")));
    }

    #[test]
    fn another_klipper_has_hours_only() {
        let status = serde_json::json!({ "extruder": { "temperature": 25.0, "pressure_advance": 0.04 } });
        let (_, totals) = u1();
        let u = parse(&status, &totals);
        assert!(u.heads.is_empty());
        assert_eq!(u.jobs, 373);
        assert_eq!(u.purifier_hours, None);
        // No history component: zeros, not an error.
        assert_eq!(parse(&status, &Value::Null).jobs, 0);
    }

    /// A real printer: `MAINT_HOST=192.168.0.144 cargo test --lib real_printer -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_printer() {
        let host = std::env::var("MAINT_HOST").expect("MAINT_HOST");
        let u = tauri::async_runtime::block_on(usage(&host, 7125)).unwrap();
        println!("{}", serde_json::to_string(&u).unwrap());
        assert!(u.jobs > 0);
    }
}
