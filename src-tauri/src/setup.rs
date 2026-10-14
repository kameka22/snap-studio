//! What the AI needs on this machine, mode by mode.
//!
//! Two ways to run Claude: in a sandbox (yolobox and a container engine) or
//! directly on this Mac (Python and the modeling modules, which Claude runs
//! itself). Both need Claude Code, recent enough for the chat view's
//! protocol, and a signed-in account. The checks are quick and bounded —
//! no model call, no image build — and run side by side.
//!
//! Nothing here installs anything: the UI says how to.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Oldest Claude Code tested with the chat view (stream-json control
/// protocol, `auth status --json`).
pub const MIN_CLAUDE: (u32, u32, u32) = (2, 1, 286);

/// The modules Claude's tools import (see `ia_tools/`).
pub const MODULES: [&str; 3] = ["trimesh", "manifold3d", "numpy"];

/// Container engines yolobox can drive, in order of preference.
const RUNTIMES: [&str; 3] = ["docker", "podman", "container"];

/// A check's outcome.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Ok,
    /// Not installed.
    Missing,
    /// Installed, but older than needed.
    TooOld,
    /// Installed, but not running (a container engine).
    Stopped,
    /// Claude is not signed in.
    SignedOut,
    /// Could not be checked because something it needs is missing.
    Skipped,
    /// Not available on this system.
    Unsupported,
    /// Nothing to check, something to know.
    Info,
}

#[derive(Serialize, Clone, Debug)]
pub struct Item {
    /// "claude", "account", "sandbox_account", "yolobox", "runtime", "image",
    /// "python" or a module name.
    pub key: String,
    pub state: State,
    /// The modes it serves: "container", "local", or both.
    pub modes: Vec<&'static str>,
    /// Version found, engine name… whatever helps the UI say it.
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Ready {
    pub container: bool,
    pub local: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct Report {
    pub items: Vec<Item>,
    pub ready: Ready,
    /// The running container engine yolobox is told to use.
    pub runtime: Option<String>,
    /// "macos", "windows" or "linux": install instructions differ.
    pub os: &'static str,
    pub min_claude: String,
    /// The Python found refuses `pip install` outside a virtual environment
    /// (PEP 668: Homebrew's, Debian's…): the install command needs
    /// `--break-system-packages`.
    pub python_managed: bool,
}

const BOTH: [&str; 2] = ["container", "local"];

fn item(key: &str, state: State, modes: &[&'static str], detail: Option<String>) -> Item {
    Item {
        key: key.to_string(),
        state,
        modes: modes.to_vec(),
        detail,
    }
}

// ------------------------------------------------------------ running things

/// Runs a command with a deadline: its success and standard output, or
/// `None` if it could not start or took too long.
fn probe(program: &Path, args: &[&str], deadline: Duration) -> Option<(bool, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(p) = crate::pty::child_path() {
        cmd.env("PATH", p);
    }
    crate::util::no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let end = Instant::now() + deadline;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some((status.success(), reader.join().unwrap_or_default())),
            Ok(None) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// "2.1.286 (Claude Code)" → (2, 1, 286).
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let word = s
        .split_whitespace()
        .map(|w| w.trim_start_matches('v'))
        .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut n = word.split('.').map(|p| {
        p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<u32>().ok()
    });
    Some((n.next()??, n.next().flatten().unwrap_or(0), n.next().flatten().unwrap_or(0)))
}

fn version_str(v: (u32, u32, u32)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

// ------------------------------------------------------------ the checks

fn check_claude() -> Item {
    let Some(bin) = crate::util::which("claude") else {
        return item("claude", State::Missing, &BOTH, None);
    };
    let version = probe(&bin, &["--version"], Duration::from_secs(10)).and_then(|(_, out)| parse_version(&out));
    match version {
        Some(v) if v >= MIN_CLAUDE => item("claude", State::Ok, &BOTH, Some(version_str(v))),
        Some(v) => item("claude", State::TooOld, &BOTH, Some(version_str(v))),
        // Present but silent: let the account check say more.
        None => item("claude", State::Ok, &BOTH, None),
    }
}

/// The Mac's sign-in, and the sandbox's own token: the sandbox is signed in
/// with either.
fn check_accounts(claude_ok: bool) -> Vec<Item> {
    if !claude_ok {
        return vec![item("account", State::Skipped, &BOTH, None)];
    }
    let host = crate::auth::status("local");
    let token = crate::auth::sandbox_token().is_some();
    let who = host.email.clone();
    match (host.logged_in, token) {
        (true, _) => vec![item("account", State::Ok, &BOTH, who)],
        (false, true) => vec![
            item("account", State::SignedOut, &["local"], None),
            item("sandbox_account", State::Ok, &["container"], None),
        ],
        (false, false) => vec![item("account", State::SignedOut, &BOTH, None)],
    }
}

/// A container engine's state: running, installed but stopped, or absent.
fn runtime_state(name: &str) -> State {
    let Some(bin) = crate::util::which(name) else {
        return State::Missing;
    };
    let args: &[&str] = match name {
        "docker" => &["info", "--format", "{{.ServerVersion}}"],
        "podman" => &["info", "--format", "{{.Host.Arch}}"],
        _ => &["system", "status"],
    };
    match probe(&bin, args, Duration::from_millis(2500)) {
        Some((true, _)) => State::Ok,
        _ => State::Stopped,
    }
}

fn check_sandbox() -> (Vec<Item>, Option<String>) {
    if cfg!(windows) {
        return (vec![item("runtime", State::Unsupported, &["container"], None)], None);
    }
    let mut items = vec![item(
        "yolobox",
        if crate::util::which("yolobox").is_some() { State::Ok } else { State::Missing },
        &["container"],
        None,
    )];
    let states: Vec<(String, State)> = std::thread::scope(|s| {
        let handles: Vec<_> = RUNTIMES.iter().map(|r| s.spawn(move || (r.to_string(), runtime_state(r)))).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let running = states.iter().find(|(_, st)| *st == State::Ok).map(|(n, _)| n.clone());
    let installed: Vec<String> = states.iter().filter(|(_, st)| *st != State::Missing).map(|(n, _)| n.clone()).collect();
    let runtime = match (&running, installed.is_empty()) {
        (Some(n), _) => item("runtime", State::Ok, &["container"], Some(n.clone())),
        (None, false) => item("runtime", State::Stopped, &["container"], Some(installed.join(", "))),
        (None, true) => item("runtime", State::Missing, &["container"], None),
    };
    items.push(runtime);
    items.push(item("image", State::Info, &["container"], None));
    (items, running)
}

/// On macOS, `/usr/bin/python3` is a stub that offers to install the
/// developer tools when they are missing: it is not run in that case.
fn usable_python() -> Option<PathBuf> {
    let p = crate::util::which("python3")?;
    if cfg!(target_os = "macos") && p == Path::new("/usr/bin/python3") {
        let tools = probe(Path::new("/usr/bin/xcode-select"), &["-p"], Duration::from_secs(3));
        if !matches!(tools, Some((true, _))) {
            return None;
        }
    }
    Some(p)
}

/// Python's version, whether pip is restricted, and which modules import,
/// in one run.
fn check_python() -> (Vec<Item>, bool) {
    let local = ["local"];
    let Some(py) = usable_python() else {
        let mut v = vec![item("python", State::Missing, &local, None)];
        v.extend(MODULES.iter().map(|m| item(m, State::Skipped, &local, None)));
        return (v, false);
    };
    let script = format!(
        "import sys, os, sysconfig, importlib\nprint('python', sys.version.split()[0])\nprint('managed', os.path.exists(os.path.join(sysconfig.get_paths()['stdlib'], 'EXTERNALLY-MANAGED')))\nfor m in {MODULES:?}:\n    try:\n        importlib.import_module(m)\n        print(m, 'ok')\n    except Exception:\n        print(m, 'missing')\n"
    );
    let out = probe(&py, &["-c", &script], Duration::from_secs(30)).map(|(_, o)| o).unwrap_or_default();
    (parse_python(&out), out.lines().any(|l| l.trim() == "managed True"))
}

/// The output of `check_python`'s script.
fn parse_python(out: &str) -> Vec<Item> {
    let local = ["local"];
    let line = |key: &str| out.lines().find_map(|l| l.strip_prefix(&format!("{key} ")).map(str::trim));
    let mut v = vec![match line("python") {
        Some(ver) => item("python", State::Ok, &local, Some(ver.to_string())),
        None => item("python", State::Missing, &local, None),
    }];
    let python_ok = v[0].state == State::Ok;
    for m in MODULES {
        let st = match line(m) {
            Some("ok") => State::Ok,
            _ if !python_ok => State::Skipped,
            _ => State::Missing,
        };
        v.push(item(m, st, &local, None));
    }
    v
}

/// A mode is ready when every check that serves it passes.
fn readiness(items: &[Item]) -> Ready {
    let ready = |mode: &str| {
        items
            .iter()
            .filter(|i| i.modes.contains(&mode) && i.state != State::Info)
            .all(|i| i.state == State::Ok)
    };
    Ready {
        container: ready("container"),
        local: ready("local"),
    }
}

/// The running container engine, as last checked.
fn last_runtime() -> &'static Mutex<Option<String>> {
    static R: Mutex<Option<String>> = Mutex::new(None);
    &R
}

/// The engine yolobox should use: the one found running at the last check.
/// `None` lets yolobox pick.
pub fn runtime() -> Option<String> {
    last_runtime().lock().unwrap().clone()
}

/// yolobox's flags for the engine to use, after its subcommand.
pub fn runtime_args() -> Vec<String> {
    runtime().map(|r| vec!["--runtime".to_string(), r]).unwrap_or_default()
}

/// Everything the AI needs, mode by mode.
pub fn check() -> Report {
    let (claude, sandbox, python) = std::thread::scope(|s| {
        let c = s.spawn(|| {
            let claude = check_claude();
            let ok = claude.state == State::Ok;
            (claude, check_accounts(ok))
        });
        let b = s.spawn(check_sandbox);
        let p = s.spawn(check_python);
        (c.join().unwrap(), b.join().unwrap(), p.join().unwrap())
    });
    let (claude, accounts) = claude;
    let (sandbox_items, running) = sandbox;
    let (python, python_managed) = python;
    let mut items = vec![claude];
    items.extend(accounts);
    items.extend(sandbox_items);
    items.extend(python);
    *last_runtime().lock().unwrap() = running.clone();
    Report {
        ready: readiness(&items),
        items,
        runtime: running,
        os: if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            "linux"
        },
        min_claude: version_str(MIN_CLAUDE),
        python_managed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_and_compared() {
        assert_eq!(parse_version("2.1.286 (Claude Code)"), Some((2, 1, 286)));
        assert_eq!(parse_version("v0.19.7"), Some((0, 19, 7)));
        assert_eq!(parse_version("Python 3.12.4"), Some((3, 12, 4)));
        assert_eq!(parse_version("3.13.0rc1"), Some((3, 13, 0)));
        assert_eq!(parse_version("nothing"), None);
        assert!(parse_version("2.1.290").unwrap() >= MIN_CLAUDE);
        assert!(parse_version("2.0.999").unwrap() < MIN_CLAUDE);
        assert!(parse_version("3.0").unwrap() >= MIN_CLAUDE);
    }

    #[test]
    fn python_output_is_read() {
        let v = parse_python("python 3.12.4\ntrimesh ok\nmanifold3d missing\nnumpy ok\n");
        let st = |k: &str| v.iter().find(|i| i.key == k).unwrap().state;
        assert_eq!(st("python"), State::Ok);
        assert_eq!(st("trimesh"), State::Ok);
        assert_eq!(st("manifold3d"), State::Missing);
        assert_eq!(v[0].detail.as_deref(), Some("3.12.4"));
        // Python did not run: the modules could not be checked.
        let none = parse_python("");
        assert!(none[1..].iter().all(|i| i.state == State::Skipped));
    }

    #[test]
    fn a_mode_is_ready_only_when_all_its_checks_pass() {
        let items = vec![
            item("claude", State::Ok, &BOTH, None),
            item("account", State::Ok, &BOTH, None),
            item("yolobox", State::Ok, &["container"], None),
            item("runtime", State::Stopped, &["container"], None),
            item("image", State::Info, &["container"], None),
            item("python", State::Ok, &["local"], None),
            item("trimesh", State::Ok, &["local"], None),
        ];
        let r = readiness(&items);
        assert!(!r.container, "the engine is stopped");
        assert!(r.local, "information lines do not count");

        let mut old = items.clone();
        old[0].state = State::TooOld;
        let r = readiness(&old);
        assert!(!r.container && !r.local, "Claude serves both modes");
    }

    /// On this machine: `cargo test --lib real_ai_check -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_ai_check() {
        let t = Instant::now();
        let r = check();
        for i in &r.items {
            println!("{:<16} {:?} {:?} {:?}", i.key, i.state, i.modes, i.detail);
        }
        println!("ready {:?}, runtime {:?}, pip managed {}, {} ms", r.ready, r.runtime, r.python_managed, t.elapsed().as_millis());
        if std::env::var("AI_JSON").is_ok() {
            println!("JSON {}", serde_json::to_string(&r).unwrap());
        }
    }
}
