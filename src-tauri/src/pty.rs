//! Terminals of the AI conversations.
//!
//! We do not imitate Claude Code: we run it for real, in a pseudo-terminal.
//! The UI shows its output as is, and sends it the keystrokes. Everything the
//! tool can do — plan mode, slash commands, `@file`, interruption — therefore
//! works without coding anything.
//!
//! Bytes go up in base64: split when read, they may cut an accented character
//! in two, and only the emulator on the UI side can glue the pieces back.

use crate::ia::Conversation;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Chunk {
    id: String,
    b64: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: String,
    code: i32,
}

struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// The write channel has its own lock: writing may block if the terminal
    /// does not consume, and that must not freeze everything else.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Executables found on the machine.
pub struct Tools {
    pub claude: Option<PathBuf>,
    pub yolobox: Option<PathBuf>,
}

impl Tools {
    pub fn detect() -> Tools {
        Tools {
            claude: crate::util::which("claude"),
            yolobox: crate::util::which("yolobox"),
        }
    }
}

/// The command line that opens the conversation.
///
/// The conversation id is also the Claude session's: `--session-id` on the
/// first opening, `--resume` afterwards. It is what makes resuming reliable
/// without ever digging into Claude's history.
///
/// The container mode's form was established against yolobox v0.19.4: its
/// flags follow the subcommand, and it passes on to Claude whatever it does
/// not recognize — a `--` separator would make it swallow the rest.
pub fn command_line(c: &Conversation, tools: &Tools, resume: bool) -> Result<Vec<String>> {
    let claude = tools
        .claude
        .as_ref()
        .ok_or_else(|| anyhow!(crate::t!("err.no_claude")))?;

    let mut inner: Vec<String> = Vec::new();
    if resume {
        inner.push("--resume".into());
        inner.push(c.id.clone());
    } else {
        inner.push("--session-id".into());
        inner.push(c.id.clone());
    }

    if c.engine == "container" {
        let yolobox = tools
            .yolobox
            .as_ref()
            .ok_or_else(|| anyhow!(crate::t!("err.no_yolobox")))?;
        if !resume && !c.prompt.is_empty() {
            inner.push(c.prompt.clone());
        }
        // yolobox's flags go after the subcommand, and whatever it does not
        // recognize goes to Claude — hence no separator.
        //
        // Full permissions are not requested here: the sandbox already grants them
        // on its own, and the option would also trigger its own acceptance screen.
        //
        // `--claude-config` shares the configuration and, above all, mounts the
        // sessions folder: that is what makes resuming possible from the host.
        let mut argv = vec![
            yolobox.to_string_lossy().to_string(),
            "claude".into(),
            "--claude-config".into(),
            "--customize-file".into(),
            crate::ia::dockerfile().to_string_lossy().to_string(),
        ];
        // The engine found running at the last check (Docker, Podman…).
        argv.extend(crate::setup::runtime_args());
        argv.extend(inner);
        return Ok(argv);
    }

    // Locally, Claude works on your Mac: file edits are accepted outright,
    // commands still need your approval.
    inner.push("--permission-mode".into());
    inner.push("acceptEdits".into());
    if !resume && !c.prompt.is_empty() {
        inner.push(c.prompt.clone());
    }
    let mut argv = vec![claude.to_string_lossy().to_string()];
    argv.extend(inner);
    Ok(argv)
}

/// Removes the inherited session markers from the environment.
///
/// An app launched from a Claude Code terminal inherits them, and Claude Code,
/// seeing them, **stops recording the conversation**: there is then nothing
/// to resume the next time. Only `CLAUDE_CONFIG_DIR` is kept, a deliberate
/// user setting, and nothing else is touched — above all not the API
/// credentials.
fn purge_markers(cmd: &mut CommandBuilder, names: impl Iterator<Item = String>) {
    for k in inherited_markers(names) {
        cmd.env_remove(&k);
    }
}

/// The inherited variables to remove (see [`purge_markers`]).
pub fn inherited_markers(names: impl Iterator<Item = String>) -> Vec<String> {
    names
        .filter(|k| k.starts_with("CLAUDE") && k != "CLAUDE_CONFIG_DIR")
        .collect()
}

/// `PATH` for Claude: launched from the Finder, the app does not inherit the
/// terminal's, so the usual locations are added for Claude to find its tools.
pub fn child_path() -> Option<std::ffi::OsString> {
    let mut path: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(unix) {
        path.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(Into::into));
    }
    std::env::join_paths(path).ok()
}

/// True if a terminal is already running for this conversation.
pub fn is_open(id: &str) -> bool {
    sessions().lock().map(|s| s.contains_key(id)).unwrap_or(false)
}

/// Opens a conversation's terminal, or does nothing if it already runs.
pub fn open(app: &AppHandle, c: &Conversation, cols: u16, rows: u16) -> Result<()> {
    // Two simultaneous requests would start two Claudes on the same session:
    // openings happen one at a time.
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _gate = GATE.get_or_init(|| Mutex::new(())).lock().unwrap();
    if is_open(&c.id) {
        return Ok(());
    }
    let ws = crate::ia::workspace(&c.id);
    if !ws.is_dir() {
        return Err(anyhow!(crate::t!("err.no_workspace")));
    }
    // One process per session: the chat view gives way.
    crate::chat::close(&c.id);

    // Instructions, tools and previews brought up to date before Claude reads them.
    crate::ia::refresh_workspace(&c.id);

    let tools = Tools::detect();
    // The truth is on disk, not in our record: a session can only be resumed
    // if Claude wrote one.
    let argv = command_line(c, &tools, crate::ia::has_session(&c.id))?;

    let envs = crate::auth::sandbox_env(&c.engine);
    spawn_terminal(app, &c.id, &argv, &ws, &envs, cols, rows, None)?;

    // The folder is watched while the terminal lives — not while the screen is
    // shown: what Claude writes while one looks elsewhere must still be
    // archived.
    let _ = crate::ia::watch_start(app.clone(), &c.id);

    // Once started, the session exists for Claude: the next opening must
    // resume it rather than create it.
    crate::ia::mark_started(&c.id);
    Ok(())
}

/// Bytes read from a terminal, for a caller that watches its output.
pub type Tap = Box<dyn FnMut(&[u8]) + Send>;

/// Runs `argv` in a pseudo-terminal registered under `key`: its output goes
/// to the UI as `ia-pty` events (and to `tap` when given), its end as
/// `ia-exit`. Keystrokes come back through [`write`].
#[allow(clippy::too_many_arguments)]
pub fn spawn_terminal(
    app: &AppHandle,
    key: &str,
    argv: &[String],
    cwd: &std::path::Path,
    envs: &[(String, String)],
    cols: u16,
    rows: u16,
    mut tap: Option<Tap>,
) -> Result<()> {
    let pair = native_pty_system().openpty(PtySize {
        rows: rows.max(4),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(p) = child_path() {
        cmd.env("PATH", p);
    }
    purge_markers(&mut cmd, std::env::vars().map(|(k, _)| k));
    for (k, v) in envs {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    sessions().lock().unwrap().insert(
        key.to_string(),
        Session {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
        },
    );

    let id = key.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(t) = tap.as_mut() {
                        t(&buf[..n]);
                    }
                    let _ = app.emit(
                        "ia-pty",
                        Chunk {
                            id: id.clone(),
                            b64: crate::util::b64_encode(&buf[..n]),
                        },
                    );
                }
            }
        }
        let code = close_and_wait(&id);
        let _ = app.emit("ia-exit", Exit { id, code });
    });
    Ok(())
}

pub fn write(id: &str, data: &str) -> Result<()> {
    // Take the channel, then release the global lock before writing: a large
    // paste may block for several seconds.
    let w = {
        let s = sessions().lock().unwrap();
        s.get(id).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?.writer.clone()
    };
    let mut w = w.lock().unwrap();
    w.write_all(data.as_bytes())?;
    w.flush()?;
    Ok(())
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<()> {
    let s = sessions().lock().unwrap();
    let sess = s.get(id).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
    sess.master.resize(PtySize {
        rows: rows.max(4),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;
    Ok(())
}

/// Time left to Claude to leave on its own.
const GRACE: std::time::Duration = std::time::Duration::from_millis(2500);

/// Removes the session and waits for the process to end.
///
/// Ask politely first. An interactive tool has some tidying to do on its way
/// out — if only writing its conversation to disk — and killing it outright
/// prevents that. The hard way remains, but as a last resort.
fn close_and_wait(id: &str) -> i32 {
    crate::ia::watch_stop(id);
    let Some(mut sess) = sessions().lock().unwrap().remove(id) else {
        return 0;
    };

    // Esc closes a possible dialog, then two quick interrupts make Claude Code
    // exit.
    if let Ok(mut w) = sess.writer.lock() {
        let _ = w.write_all(b"\x1b");
        let _ = w.flush();
        let _ = w.write_all(b"\x03\x03");
        let _ = w.flush();
    }

    let deadline = std::time::Instant::now() + GRACE;
    let mut code = None;
    while std::time::Instant::now() < deadline {
        match sess.child.try_wait() {
            Ok(Some(st)) => {
                code = Some(st.exit_code() as i32);
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(80)),
            Err(_) => break,
        }
    }

    code.unwrap_or_else(|| {
        let _ = sess.child.kill();
        sess.child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1)
    })
}

pub fn close(id: &str) {
    close_and_wait(id);
}

/// Closes all terminals — when the app closes.
pub fn close_all() {
    let ids: Vec<String> = sessions()
        .lock()
        .map(|s| s.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        close_and_wait(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(engine: &str, prompt: &str, started: bool) -> Conversation {
        Conversation {
            id: "11111111-2222-3333-4444-555555555555".into(),
            title: "Essai".into(),
            source: "/tmp/x.3mf".into(),
            source_name: "x.3mf".into(),
            prompt: prompt.into(),
            engine: engine.into(),
            created_at: 0,
            updated_at: 0,
            version: 1,
            saved: None,
            started,
            kind: String::new(),
            dest_dir: None,
            bounds: None,
        }
    }

    fn tools() -> Tools {
        Tools {
            claude: Some(PathBuf::from("/usr/local/bin/claude")),
            yolobox: Some(PathBuf::from("/opt/homebrew/bin/yolobox")),
        }
    }

    #[test]
    fn first_run_creates_the_session() {
        let c = conv("local", "Tilt by 15°", false);
        let argv = command_line(&c, &tools(), false).unwrap();
        assert_eq!(argv[0], "/usr/local/bin/claude");
        assert!(argv.contains(&"--session-id".to_string()));
        assert!(argv.contains(&c.id));
        assert!(!argv.contains(&"--resume".to_string()));
        assert_eq!(argv.last().unwrap(), "Tilt by 15°", "the request is passed as is");
    }

    #[test]
    fn reopening_resumes_it() {
        let c = conv("local", "Tilt by 15°", true);
        let argv = command_line(&c, &tools(), true).unwrap();
        assert!(argv.contains(&"--resume".to_string()));
        assert!(!argv.contains(&"--session-id".to_string()));
        assert!(
            !argv.contains(&"Tilt by 15°".to_string()),
            "the initial request must not be sent again when resuming"
        );
    }

    /// The exact form was checked against the real yolobox: its flags follow
    /// the subcommand, it passes on to Claude what it does not recognize, and a
    /// `--` separator would make it swallow the rest.
    #[test]
    fn container_wraps_the_command() {
        let c = conv("container", "Hollow the base", false);
        let argv = command_line(&c, &tools(), false).unwrap();
        assert_eq!(argv[0], "/opt/homebrew/bin/yolobox");
        assert_eq!(argv[1], "claude", "the subcommand comes first");
        assert!(!argv.iter().any(|a| a == "--"), "no separator");
        assert!(
            !argv.iter().any(|a| a == "--dangerously-skip-permissions"),
            "the sandbox handles it, and the option would open a dialog"
        );

        let cfg = argv.iter().position(|a| a == "--claude-config").unwrap();
        let sid = argv.iter().position(|a| a == "--session-id").unwrap();
        assert!(cfg < sid, "the sandbox flags come before Claude's");
        assert_eq!(argv.last().unwrap(), "Hollow the base");
    }

    #[test]
    fn missing_tools_are_reported() {
        let none = Tools {
            claude: None,
            yolobox: None,
        };
        let err = command_line(&conv("local", "", false), &none, false).unwrap_err();
        assert!(err.to_string().contains("Claude Code"));

        let no_box = Tools {
            claude: Some(PathBuf::from("/usr/local/bin/claude")),
            yolobox: None,
        };
        let err = command_line(&conv("container", "", false), &no_box, false).unwrap_err();
        assert!(err.to_string().contains("yolobox"));
    }

    /// A terminal on a trivial command: write, read back.
    #[test]
    fn a_terminal_carries_bytes_both_ways() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/cat");
        cmd.env("TERM", "dumb");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"bonjour\n").unwrap();
        writer.flush().unwrap();

        let mut seen = String::new();
        let mut buf = [0u8; 256];
        for _ in 0..20 {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if seen.contains("bonjour") {
                        break;
                    }
                }
            }
        }
        let _ = child.kill();
        assert!(seen.contains("bonjour"), "lu : {seen:?}");
    }
}

#[cfg(test)]
mod essai_reel {
    use super::*;
    use std::time::{Duration, Instant};

    /// Really runs Claude Code in a pseudo-terminal and looks at what comes
    /// out. Without an initial request nothing is sent to the model: it only
    /// checks that the tool starts in the right place.
    ///
    /// `IA_PTY=/path/object.3mf cargo test essai_reel -- --nocapture`
    #[test]
    fn claude_starts_in_the_workspace() {
        let Ok(src) = std::env::var("IA_PTY") else {
            return;
        };
        let c = crate::ia::create(std::path::Path::new(&src), "", "local").unwrap();
        // Instructions, tools and previews brought up to date before Claude reads them.
    crate::ia::refresh_workspace(&c.id);

    let tools = Tools::detect();
        let argv = command_line(&c, &tools, false).unwrap();
        println!("commande : {argv:?}");

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new(&argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        cmd.cwd(crate::ia::workspace(&c.id));
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let mut seen = Vec::new();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(12) {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
                seen.extend_from_slice(&chunk);
            }
            let text = String::from_utf8_lossy(&seen);
            if text.contains("bypass") || text.contains("?") && seen.len() > 2000 {
                break;
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&seen);
        println!("--- {} bytes received ---", seen.len());
        println!("{}", text.chars().take(1500).collect::<String>());
        assert!(seen.len() > 200, "Claude showed nothing");
        assert!(
            seen.contains(&0x1b),
            "no escape sequence: this is not a terminal interface"
        );
        crate::ia::remove(&c.id).unwrap();
    }
}

#[cfg(test)]
mod env_tests {
    /// Inherited session markers must disappear from the environment passed to
    /// Claude Code.
    ///
    /// It is the exact cause of unrecoverable conversations: seeing
    /// `CLAUDE_CODE_CHILD_SESSION`, Claude shows "Transcript saving is off" and
    /// writes no session — `--resume` and `/resume` then find nothing.
    #[test]
    fn inherited_markers_are_dropped() {
        use super::*;
        let planted = [
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_CHILD_SESSION", "oui"),
            ("CLAUDE_CODE_SESSION_ID", "abc"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_PID", "123"),
            ("CLAUDE_CONFIG_DIR", "/tmp/conf"),
            ("ANTHROPIC_API_KEY", "secret"),
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/x"),
        ];
        let mut cmd = CommandBuilder::new("/bin/echo");
        for (k, v) in planted {
            cmd.env(k, v);
        }
        purge_markers(&mut cmd, planted.iter().map(|(k, _)| k.to_string()));

        let left: std::collections::HashMap<&str, &str> =
            cmd.iter_full_env_as_str().collect();
        for k in [
            "CLAUDECODE",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_PID",
        ] {
            assert!(!left.contains_key(k), "“{k}” should have disappeared");
        }
        assert_eq!(left.get("CLAUDE_CONFIG_DIR"), Some(&"/tmp/conf"), "intended setting");
        assert_eq!(left.get("ANTHROPIC_API_KEY"), Some(&"secret"), "left untouched");
        assert_eq!(left.get("PATH"), Some(&"/usr/bin"));
        assert_eq!(left.get("HOME"), Some(&"/Users/x"));
    }
}
