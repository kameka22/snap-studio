//! Impressions : file d'attente, impressions lancées, historique.
//!
//! Les aperçus de découpe vivent dans un dossier temporaire ; une impression
//! mise en file doit survivre à un redémarrage. Chaque travail garde donc son
//! G-code dans `jobs/<id>.gcode`, et le magasin `jobs.json` le décrit : état,
//! imprimante, options de lancement, profils, bilan. L'ordre des travaux
//! `queued` dans le magasin est l'ordre de la file.
//!
//! Une tâche de fond interroge les imprimantes : elle publie l'instantané des
//! impressions (`prints-status`), clôt les travaux terminés et, quand une
//! imprimante est libre avec une file non vide, demande à l'interface s'il
//! faut lancer la suivante (`queue-next`). Rien ne part sans l'utilisateur.

use crate::gcode::SliceStats;
use crate::printers::{self, StartOptions, Status};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Impressions terminées conservées.
const HISTORY: usize = 20;
/// Intervalle d'interrogation des imprimantes.
const POLL: Duration = Duration::from_secs(8);
/// Juste après le lancement, l'imprimante peut encore se dire libre : un
/// travail aussi récent n'est pas clos.
const GRACE_S: u64 = 90;

/// Profils de la découpe, pour la fiche.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Profile {
    pub machine: String,
    pub process: String,
    pub filaments: Vec<String>,
    pub bed: Option<String>,
    /// Libellé du plateau tel qu'affiché à la découpe.
    pub bed_label: Option<String>,
    pub colors: Vec<Option<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Job {
    pub id: String,
    /// Nom affiché, sans extension.
    pub name: String,
    pub printer_id: String,
    /// G-code conservé par Snap Studio.
    pub file: String,
    /// Nom du fichier sur l'imprimante (connu une fois lancé).
    #[serde(default)]
    pub remote: String,
    /// queued | printing | complete | cancelled | error | finished
    pub state: String,
    pub created: u64,
    #[serde(default)]
    pub started: Option<u64>,
    #[serde(default)]
    pub finished: Option<u64>,
    pub options: StartOptions,
    pub tools: Vec<u8>,
    #[serde(default)]
    pub profile: Profile,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub stats: Option<SliceStats>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn dir() -> PathBuf {
    let d = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("fr.carlini.snapstudio")
        .join("jobs");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Le magasin est lu et écrit sous ce verrou : interface et tâche de fond y
/// touchent toutes deux.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn load_unlocked() -> Vec<Job> {
    std::fs::read(dir().join("jobs.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_unlocked(list: &[Job]) -> Result<()> {
    let path = dir().join("jobs.json");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(list)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Modifie le magasin d'un bloc.
fn update<T>(f: impl FnOnce(&mut Vec<Job>) -> Result<T>) -> Result<T> {
    let _g = lock();
    let mut list = load_unlocked();
    let out = f(&mut list)?;
    prune(&mut list);
    save_unlocked(&list)?;
    Ok(out)
}

/// Garde les `HISTORY` dernières impressions terminées ; les autres partent
/// avec leur G-code.
fn prune(list: &mut Vec<Job>) {
    let mut done: Vec<(u64, String)> = list
        .iter()
        .filter(|j| is_done(&j.state))
        .map(|j| (j.finished.unwrap_or(j.created), j.id.clone()))
        .collect();
    if done.len() <= HISTORY {
        return;
    }
    done.sort();
    let drop: HashSet<String> = done[..done.len() - HISTORY].iter().map(|(_, id)| id.clone()).collect();
    list.retain(|j| {
        if drop.contains(&j.id) {
            let _ = std::fs::remove_file(&j.file);
            false
        } else {
            true
        }
    });
}

fn is_done(state: &str) -> bool {
    matches!(state, "complete" | "cancelled" | "error" | "finished")
}

pub fn list() -> Vec<Job> {
    let _g = lock();
    load_unlocked()
}

pub fn get(id: &str) -> Option<Job> {
    list().into_iter().find(|j| j.id == id)
}

/// Ce que l'interface sait de la découpe au moment de l'ajout.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct NewJob {
    /// Identifiant choisi d'avance (il entre dans le nom du fichier envoyé).
    pub id: Option<String>,
    pub name: String,
    pub printer_id: String,
    pub options: StartOptions,
    pub tools: Vec<u8>,
    pub profile: Profile,
    pub source: Option<String>,
    /// Bilan déjà connu (remise en file) ; sinon recalculé depuis le G-code.
    #[serde(skip)]
    pub stats: Option<SliceStats>,
}

/// Nom du fichier sur l'imprimante : unique par travail, pour que deux
/// impressions du même modèle ne s'écrasent pas et restent distinguables.
pub fn remote_name(name: &str, id: &str) -> String {
    format!("{}-{}.gcode", name, &id[..id.len().min(6)])
}

/// Copie le G-code dans le magasin et enregistre le travail. Lent (copie,
/// analyse du G-code) : à appeler hors du fil asynchrone.
pub fn add(gcode: &Path, new: NewJob, state: &str, remote: &str) -> Result<Job> {
    let id = new.id.clone().unwrap_or_else(printers::new_id);
    let file = dir().join(format!("{id}.gcode"));
    std::fs::copy(gcode, &file)?;
    // Bilan recalculé depuis le fichier : il voyage avec le travail.
    let stats = new.stats.clone().or_else(|| {
        std::fs::File::open(&file)
            .ok()
            .and_then(|f| crate::gcode::parse(f).ok())
            .map(|d| crate::gcode::stats(&d))
    });
    let job = Job {
        id,
        name: if new.name.is_empty() { "impression".into() } else { new.name },
        printer_id: new.printer_id,
        file: file.to_string_lossy().to_string(),
        remote: remote.to_string(),
        state: state.to_string(),
        created: now(),
        started: (state == "printing").then(now),
        finished: None,
        options: new.options,
        tools: new.tools,
        profile: new.profile,
        source: new.source,
        stats,
    };
    let j = job.clone();
    update(move |list| {
        list.push(j);
        Ok(())
    })?;
    Ok(job)
}

pub fn remove(id: &str) -> Result<()> {
    update(|list| {
        if let Some(j) = list.iter().find(|j| j.id == id) {
            // Seule une impression qui tourne vraiment est protégée : une
            // imprimante supprimée, injoignable ou libre ne la clora jamais.
            let running = snapshot()
                .iter()
                .any(|l| l.printer_id == j.printer_id && l.status.online && busy(&l.status.state));
            if j.state == "printing" && running {
                return Err(anyhow!("impression en cours : annulez-la d'abord"));
            }
            let _ = std::fs::remove_file(&j.file);
        }
        list.retain(|j| j.id != id);
        Ok(())
    })
}

/// Déplace un travail dans la file (`delta` : -1 vers le haut, +1 vers le bas).
pub fn shift(id: &str, delta: i32) -> Result<()> {
    update(|list| {
        let queued: Vec<usize> = list.iter().enumerate().filter(|(_, j)| j.state == "queued").map(|(i, _)| i).collect();
        let Some(pos) = queued.iter().position(|&i| list[i].id == id) else {
            return Ok(());
        };
        let target = pos as i32 + delta;
        if target < 0 || target as usize >= queued.len() {
            return Ok(());
        }
        list.swap(queued[pos], queued[target as usize]);
        Ok(())
    })
}

/// Change l'imprimante ou les options d'un travail en attente.
pub fn edit(id: &str, printer_id: Option<String>, options: Option<StartOptions>) -> Result<Job> {
    update(|list| {
        let j = list.iter_mut().find(|j| j.id == id).ok_or_else(|| anyhow!("travail inconnu"))?;
        if let Some(p) = printer_id {
            j.printer_id = p;
        }
        if let Some(o) = options {
            j.options = o;
        }
        Ok(j.clone())
    })
}

/// Remet en file une impression de l'historique (nouvelle entrée).
pub fn requeue(id: &str) -> Result<Job> {
    let old = get(id).ok_or_else(|| anyhow!("travail inconnu"))?;
    add(
        Path::new(&old.file),
        NewJob {
            id: None,
            stats: old.stats,
            name: old.name,
            printer_id: old.printer_id,
            options: old.options,
            tools: old.tools,
            profile: old.profile,
            source: old.source,
        },
        "queued",
        "",
    )
}

/// Le travail vient de partir sur l'imprimante.
pub fn mark_started(id: &str, remote: &str) -> Result<()> {
    update(|list| {
        // Un travail est ajouté en fin de liste : il passe à la suite de
        // l'historique, hors de la file.
        let i = list.iter().position(|j| j.id == id).ok_or_else(|| anyhow!("travail inconnu"))?;
        let mut j = list.remove(i);
        j.state = "printing".into();
        j.remote = remote.to_string();
        j.started = Some(now());
        list.push(j);
        Ok(())
    })
}

/// Clôt les travaux en cours d'une imprimante qui ne l'est plus.
fn close_printing(printer_id: &str, state: &str) -> Vec<Job> {
    let out = update(|list| {
        let mut closed = vec![];
        let fresh = |j: &Job| j.started.is_some_and(|t| now().saturating_sub(t) < GRACE_S);
        for j in list.iter_mut().filter(|j| j.printer_id == printer_id && j.state == "printing" && !fresh(j)) {
            j.state = state.to_string();
            j.finished = Some(now());
            closed.push(j.clone());
        }
        Ok(closed)
    });
    out.unwrap_or_default()
}

fn has_printing(printer_id: &str) -> bool {
    list().iter().any(|j| j.printer_id == printer_id && j.state == "printing")
}

fn next_for(printer_id: &str) -> Option<Job> {
    list().into_iter().find(|j| j.printer_id == printer_id && j.state == "queued")
}

/* ------------------------------------------------------------ suivi */

/// Une imprimante dans l'instantané des impressions.
#[derive(Serialize, Clone)]
pub struct Live {
    pub printer_id: String,
    pub printer_name: String,
    pub status: Status,
}

#[derive(Serialize, Clone)]
struct QueueNext {
    printer_id: String,
    printer_name: String,
    /// Impression qui vient de se terminer, si on l'a vue finir.
    finished: Option<Job>,
    next: Job,
}

#[derive(Default)]
struct Monitor {
    /// Dernier état confirmé par imprimante.
    states: HashMap<String, String>,
    /// Passages consécutifs où l'imprimante s'est dite libre.
    idle: HashMap<String, u32>,
    /// Imprimantes pour lesquelles la question a déjà été posée.
    asked: HashSet<String>,
    snapshot: Vec<Live>,
}

fn monitor() -> &'static Mutex<Monitor> {
    static M: OnceLock<Mutex<Monitor>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn busy(state: &str) -> bool {
    matches!(state, "printing" | "paused")
}

/// Dernier instantané connu.
pub fn snapshot() -> Vec<Live> {
    monitor().lock().unwrap().snapshot.clone()
}

/// « Plus tard » : pas de nouvelle question avant la prochaine impression.
pub fn dismiss(printer_id: &str) {
    monitor().lock().unwrap().asked.insert(printer_id.to_string());
}

/// Pose à nouveau la question pour les imprimantes libres avec une file
/// (au démarrage de l'interface, ou à la demande).
pub fn ask_again(app: &AppHandle) {
    let mut m = monitor().lock().unwrap();
    m.asked.clear();
    let snap = m.snapshot.clone();
    drop(m);
    for live in snap {
        if live.status.online && !busy(&live.status.state) {
            offer_next(app, &live, None);
        }
    }
}

fn offer_next(app: &AppHandle, live: &Live, finished: Option<Job>) {
    let Some(next) = next_for(&live.printer_id) else { return };
    {
        let mut m = monitor().lock().unwrap();
        if !m.asked.insert(live.printer_id.clone()) {
            return;
        }
    }
    let _ = app.emit(
        "queue-next",
        QueueNext {
            printer_id: live.printer_id.clone(),
            printer_name: live.printer_name.clone(),
            finished,
            next,
        },
    );
}

/// Tâche de fond : une passe toutes les `POLL` secondes, tant que l'application vit.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tick(&app).await;
            tokio::time::sleep(POLL).await;
        }
    });
}

async fn tick(app: &AppHandle) {
    let printers = printers::load();
    let mut snap = Vec::with_capacity(printers.len());
    for p in &printers {
        let st = printers::status(&p.host, p.port).await;
        let live = Live { printer_id: p.id.clone(), printer_name: p.name.clone(), status: st };
        if live.status.online {
            observe(app, &live);
        }
        snap.push(live);
    }
    monitor().lock().unwrap().snapshot = snap.clone();
    let _ = app.emit("prints-status", snap);
}

/// Transitions d'une imprimante joignable.
///
/// Une fin d'impression n'est retenue que confirmée par deux passages
/// consécutifs et un état complet : une réponse incomplète ou un hoquet de
/// Klipper ne doivent pas clore une impression qui tourne encore.
fn observe(app: &AppHandle, live: &Live) {
    if live.status.partial {
        return;
    }
    let id = &live.printer_id;
    let state = live.status.state.as_str();
    if busy(state) {
        let mut m = monitor().lock().unwrap();
        m.states.insert(id.clone(), state.to_string());
        m.idle.insert(id.clone(), 0);
        // Nouvelle impression : la question pourra être reposée à sa fin.
        m.asked.remove(id);
        return;
    }
    let pending = has_printing(id);
    let was_busy = {
        let mut m = monitor().lock().unwrap();
        let n = m.idle.entry(id.clone()).or_insert(0);
        *n += 1;
        let confirmed = *n >= 2;
        let was_busy = m.states.get(id).is_some_and(|s| busy(s));
        if (was_busy || pending) && !confirmed {
            return;
        }
        m.states.insert(id.clone(), state.to_string());
        was_busy
    };
    // Libre : ce qu'on croyait en cours est terminé (vu finir, ou fini
    // pendant que l'application était fermée).
    let outcome = match state {
        "cancelled" => "cancelled",
        "error" => "error",
        "complete" => "complete",
        _ => "finished",
    };
    let closed = if pending { close_printing(id, outcome) } else { vec![] };
    if was_busy || !closed.is_empty() {
        let _ = app.emit("jobs-changed", ());
        let name = closed
            .first()
            .map(|j| j.name.clone())
            .or_else(|| live.status.job.clone())
            .unwrap_or_else(|| "L'impression".into());
        let verb = match outcome {
            "cancelled" => "a été annulée",
            "error" => "s'est arrêtée sur une erreur",
            _ => "est terminée",
        };
        let next = next_for(id).map(|j| format!(" Suivante en attente : {}.", j.name)).unwrap_or_default();
        notify(app, &format!("{name} {verb}"), &format!("{}.{next}", live.printer_name));
    }
    offer_next(app, live, closed.into_iter().next());
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_keeps_recent_history_and_queue() {
        let mk = |i: u64, state: &str| Job {
            id: format!("j{i}"),
            name: format!("n{i}"),
            printer_id: "p".into(),
            file: format!("/nonexistent/j{i}.gcode"),
            remote: String::new(),
            state: state.into(),
            created: i,
            started: None,
            finished: Some(i),
            options: StartOptions::default(),
            tools: vec![0],
            profile: Profile::default(),
            source: None,
            stats: None,
        };
        let mut list: Vec<Job> = (0..30).map(|i| mk(i, "complete")).collect();
        list.push(mk(100, "queued"));
        prune(&mut list);
        assert_eq!(list.iter().filter(|j| is_done(&j.state)).count(), HISTORY);
        assert!(list.iter().any(|j| j.id == "j29"), "les plus récentes restent");
        assert!(!list.iter().any(|j| j.id == "j0"), "les plus anciennes partent");
        assert!(list.iter().any(|j| j.state == "queued"), "la file n'est jamais élaguée");
    }
}
