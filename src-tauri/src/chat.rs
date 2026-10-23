//! AI conversations as a chat: Claude Code in its structured mode.
//!
//! Claude runs with `-p --input-format stream-json --output-format
//! stream-json`, the interface the Agent SDK and the IDE extensions use: one
//! JSON object per line on stdin and stdout. Its events go to the UI as the
//! `ia-chat` Tauri event; the UI's messages, interrupts and permission answers
//! come back as JSON lines. The conversation id stays Claude's session id, so
//! resuming works exactly as in the terminal view (`pty.rs`).
//!
//! Each conversation also keeps its own log, `workspace/chat.jsonl`: what the
//! view shows, kept as long as the object lives — Claude Code deletes its own
//! transcripts after `cleanupPeriodDays` — plus what is ours (attachments,
//! versions, permission answers). Claude's transcript stays the source of
//! truth for resuming; we never write into it.
//!
//! Adapted from claude-chat-panel's Rust host
//! (https://github.com/simscorpbs/claude-chat-panel, MIT License,
//! Copyright (c) 2026 simscorpbs): protocol, permission answers, history
//! filtering.

use crate::ia::Conversation;
use crate::pty::Tools;
use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Claude's arguments for the structured mode, before the session's own.
pub const CLI_ARGS: [&str; 9] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
];

/// Tool results kept in the log and sent to the view, in characters.
const RESULT_CAP: usize = 20_000;

/// Models a conversation may choose; none is the account's default.
pub const MODELS: [&str; 3] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"];

// ------------------------------------------------------------ command line

/// The command line of a conversation in chat mode.
///
/// As in the terminal view: `--session-id` on the first run, `--resume`
/// once Claude wrote a transcript; yolobox in front in container mode, its
/// flags after the subcommand and Claude's passed through. The initial request
/// is not an argument any more: it is the first message.
pub fn command_line(c: &Conversation, tools: &Tools, resume: bool) -> Result<Vec<String>> {
    let claude = tools
        .claude
        .as_ref()
        .ok_or_else(|| anyhow!(crate::t!("err.no_claude")))?;
    let mut inner: Vec<String> = CLI_ARGS.iter().map(|s| s.to_string()).collect();
    inner.push(if resume { "--resume" } else { "--session-id" }.into());
    inner.push(c.id.clone());
    if let Some(m) = c.model.as_deref().filter(|m| MODELS.contains(m)) {
        inner.push("--model".into());
        inner.push(m.to_string());
    }

    if c.engine == "container" {
        let yolobox = tools
            .yolobox
            .as_ref()
            .ok_or_else(|| anyhow!(crate::t!("err.no_yolobox")))?;
        // With pipes instead of a terminal, yolobox runs Docker with `-i` and
        // no `-t`; its `claude` alias already skips permission prompts.
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

    // Locally, Claude works on your Mac: file edits are accepted outright
    // and commands ask — in the chat, as permission cards.
    inner.push("--permission-mode".into());
    inner.push("acceptEdits".into());
    let mut argv = vec![claude.to_string_lossy().to_string()];
    argv.extend(inner);
    Ok(argv)
}

// ------------------------------------------------------------ protocol

/// An image attached by the user, as the view sends it.
#[derive(Deserialize, Clone, Debug)]
pub struct Attachment {
    pub name: String,
    pub media_type: String,
    /// Base64, without the `data:` prefix.
    pub data: String,
}

/// A message the user typed, with its images.
pub fn user_message(text: &str, images: &[Attachment]) -> Value {
    let mut content: Vec<Value> = images
        .iter()
        .map(|a| {
            json!({ "type": "image", "source": { "type": "base64", "media_type": a.media_type, "data": a.data } })
        })
        .collect();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    json!({ "type": "user", "message": { "role": "user", "content": content } })
}

/// Stops what Claude is doing.
pub fn interrupt(request_id: &str) -> Value {
    json!({ "type": "control_request", "request_id": request_id, "request": { "subtype": "interrupt" } })
}

/// The answer to a `can_use_tool` request: allowed as asked (and from now on,
/// with Claude's own suggested rules, when `always`), or denied.
///
/// `input` replaces the tool's input when given: that is how the answers to an
/// `AskUserQuestion` travel (its input plus `answers`).
pub fn permission_response(
    request_id: &str,
    request: &Value,
    allow: bool,
    always: bool,
    input: Option<&Value>,
    deny_message: &str,
) -> Value {
    let response = if allow {
        let mut r = json!({
            "behavior": "allow",
            "updatedInput": input.cloned().or_else(|| request.get("input").cloned()).unwrap_or_else(|| json!({})),
        });
        if always {
            if let Some(s) = request.get("permission_suggestions") {
                r["updatedPermissions"] = s.clone();
            }
        }
        r
    } else {
        json!({ "behavior": "deny", "message": deny_message })
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

/// Caps a tool result and drops image data, which the view does not need
/// (an image Claude read is a file of the workspace, shown from there).
fn slim_tool_result(content: &Value) -> Value {
    match content {
        Value::String(s) if s.chars().count() > RESULT_CAP => {
            Value::String(s.chars().take(RESULT_CAP).collect::<String>() + "…")
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|c| match c["type"].as_str() {
                    Some("image") => json!({ "type": "image" }),
                    Some("text") => json!({ "type": "text", "text": slim_tool_result(&c["text"]) }),
                    _ => c.clone(),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Message content without what the view never shows: thinking signatures,
/// image data, tool results beyond the cap.
fn slim_content(content: &Value) -> Value {
    match content {
        Value::Array(blocks) => Value::Array(
            blocks
                .iter()
                .map(|b| match b["type"].as_str() {
                    Some("thinking" | "redacted_thinking") => json!({ "type": "thinking" }),
                    Some("image") => json!({ "type": "image" }),
                    Some("tool_result") => {
                        let mut r = b.clone();
                        r["content"] = slim_tool_result(&b["content"]);
                        if let Some(o) = r.as_object_mut() {
                            o.remove("tool_use_result");
                        }
                        r
                    }
                    Some("tool_use") => json!({ "type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"] }),
                    _ => b.clone(),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// What of a Claude line goes to the view, slimmed; `None` for bookkeeping
/// (`rate_limit_event`, `system/status`, `thinking_tokens`…).
pub fn for_view(event: &Value) -> Option<Value> {
    let ty = event["type"].as_str()?;
    match ty {
        "system" => match event["subtype"].as_str()? {
            "init" => Some(json!({
                "type": "system", "subtype": "init", "model": event["model"], "mode": event["permissionMode"],
            })),
            "api_retry" => Some(json!({
                "type": "system", "subtype": "api_retry", "attempt": event["attempt"],
                "max_retries": event["max_retries"], "error": event["error"],
            })),
            _ => None,
        },
        "stream_event" => {
            let e = &event["event"];
            match e["type"].as_str()? {
                "message_start" => Some(json!({ "type": "stream_event", "event": { "type": "message_start" } })),
                "content_block_delta" if e["delta"]["type"] == "text_delta" => Some(json!({
                    "type": "stream_event",
                    "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": e["delta"]["text"] } },
                })),
                _ => None,
            }
        }
        "assistant" | "user" => {
            // Sub-agents' turns stay folded into their tool row for now.
            if !event["parent_tool_use_id"].is_null() {
                return None;
            }
            Some(json!({
                "type": ty,
                "message": { "id": event["message"]["id"], "content": slim_content(&event["message"]["content"]) },
            }))
        }
        "result" => Some(json!({
            "type": "result", "subtype": event["subtype"], "is_error": event["is_error"],
            "total_cost_usd": event["total_cost_usd"], "result": event["result"],
            "duration_ms": event["duration_ms"],
        })),
        "control_request" if event["request"]["subtype"] == "can_use_tool" => {
            let r = &event["request"];
            Some(json!({
                "type": "control_request",
                "request_id": event["request_id"],
                "request": {
                    "subtype": "can_use_tool", "tool_name": r["tool_name"], "display_name": r["display_name"],
                    "input": r["input"], "description": r["description"],
                    "interactive": r["requires_user_interaction"] == true,
                    "can_always": r["permission_suggestions"].as_array().is_some_and(|s| !s.is_empty()),
                },
            }))
        }
        _ => None,
    }
}

/// Whether a view event goes to the log too: streaming pieces do not, the
/// whole message that follows replaces them.
fn logged(view: &Value) -> bool {
    view["type"] != "stream_event" && view["type"] != "auth_failed"
}

/// Whether a line from Claude says it could not sign in: a retry on a 401,
/// or a result that gives up on it.
pub fn auth_failed(event: &Value) -> bool {
    match event["type"].as_str() {
        Some("system") => {
            event["subtype"] == "api_retry"
                && (event["error"] == "authentication_failed" || event["error_status"] == 401)
        }
        Some("result") => event["is_error"] == true && event["result"].as_str().is_some_and(crate::auth::is_auth_failure),
        _ => false,
    }
}

// ------------------------------------------------------------ log and history

pub fn log_path(ws: &Path) -> PathBuf {
    ws.join("chat.jsonl")
}

pub fn attachments_dir(ws: &Path) -> PathBuf {
    ws.join("attachments")
}

/// Appends events to a conversation's log.
pub fn log_append(ws: &Path, events: &[Value]) {
    if events.is_empty() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path(ws)) else {
        return;
    };
    let mut buf = String::new();
    for e in events {
        buf.push_str(&e.to_string());
        buf.push('\n');
    }
    let _ = f.write_all(buf.as_bytes());
}

/// The text Claude Code writes as a user message when a turn is interrupted.
const INTERRUPTED: &str = "[Request interrupted by user]";

/// A transcript turned into view events: the user's messages and the answers
/// with their tools, without sub-agents (`isSidechain`), meta records
/// (`isMeta`) nor the "No response requested." Claude adds after an
/// interrupt.
pub fn from_transcript(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut after_interrupt = false;
    for record in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let ty = record["type"].as_str().unwrap_or_default();
        if !matches!(ty, "user" | "assistant") || record["isSidechain"] == true || record["isMeta"] == true {
            continue;
        }
        let content = &record["message"]["content"];
        let text_of = |c: &Value| -> String {
            match c {
                Value::String(s) => s.clone(),
                Value::Array(b) => b.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(""),
                _ => String::new(),
            }
        };
        if ty == "user" && text_of(content) == INTERRUPTED {
            after_interrupt = true;
            out.push(json!({ "type": "result", "subtype": "error_during_execution", "is_error": true }));
            continue;
        }
        if ty == "assistant" && after_interrupt && text_of(content) == "No response requested." {
            after_interrupt = false;
            continue;
        }
        after_interrupt = false;
        let content = match content {
            Value::String(s) => json!([{ "type": "text", "text": s }]),
            other => slim_content(other),
        };
        out.push(json!({ "type": ty, "message": { "id": record["message"]["id"], "content": content } }));
    }
    out
}

/// Claude's transcript of a session, wherever its project folder is.
fn transcript_path(id: &str) -> Option<PathBuf> {
    let p = crate::ia::session_file(id);
    if p.is_file() {
        return Some(p);
    }
    crate::ia::claude_roots().into_iter().find_map(|root| {
        std::fs::read_dir(root.join("projects"))
            .ok()?
            .filter_map(Result::ok)
            .map(|e| e.path().join(format!("{id}.jsonl")))
            .find(|p| p.is_file())
    })
}

/// The past of a conversation: our log, or — for a conversation from before
/// it — Claude's transcript.
pub fn history_of(ws: &Path, transcript: Option<&Path>) -> Vec<Value> {
    if let Ok(text) = std::fs::read_to_string(log_path(ws)) {
        return text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    }
    transcript
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| from_transcript(&t))
        .unwrap_or_default()
}

pub fn history(id: &str) -> Vec<Value> {
    history_of(&crate::ia::workspace(id), transcript_path(id).as_deref())
}

/// File name of an attachment in the workspace: numbered, without any path.
fn attachment_name(dir: &Path, name: &str) -> String {
    let clean: String = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' })
        .collect();
    let clean = if clean.trim_matches('-').is_empty() { "image.png".to_string() } else { clean };
    // One past the highest number in the folder, not the count of files:
    // after a deletion, a count would give a number already used by an
    // attachment the log still points at (and `seen-*.png` live here too).
    let n = std::fs::read_dir(dir)
        .map(|d| {
            d.flatten()
                .filter_map(|e| e.file_name().to_str().and_then(|s| s.split('-').next()?.parse::<u32>().ok()))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
        + 1;
    format!("{n:03}-{clean}")
}

/// Saves the attachments and returns the user message as the log keeps it:
/// file names instead of data.
fn save_attachments(ws: &Path, text: &str, images: &[Attachment]) -> Value {
    let dir = attachments_dir(ws);
    let _ = std::fs::create_dir_all(&dir);
    let mut content: Vec<Value> = Vec::new();
    for a in images {
        let name = attachment_name(&dir, &a.name);
        if let Some(bytes) = crate::util::b64_decode(&a.data) {
            let _ = std::fs::write(dir.join(&name), bytes);
        }
        content.push(json!({ "type": "attachment", "name": name, "media_type": a.media_type }));
    }
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    json!({ "type": "user", "message": { "content": content } })
}

// ------------------------------------------------------------ sessions

type Listener = Arc<dyn Fn(Value) + Send + Sync>;

struct Session {
    child: Child,
    /// Its own lock: an image may take a while to write. `None` once closed:
    /// the reader thread shares the handle, so dropping this field alone
    /// would leave the pipe open and Claude waiting for input.
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// Pending permission requests, kept whole: the answer needs their
    /// `input` and `permission_suggestions`.
    permissions: Arc<Mutex<HashMap<String, Value>>>,
    next: u64,
    /// Which process this is: a reader thread only removes its own session,
    /// not the one started after it for the same conversation.
    token: u64,
}

fn next_token() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn is_open(id: &str) -> bool {
    sessions().lock().map(|s| s.contains_key(id)).unwrap_or(false)
}

/// Bytes of stderr kept: enough for the reason of a failed start.
const STDERR_TAIL: usize = 2048;

/// Reads `r` to its end into `into`, keeping its last `cap` bytes.
fn tail_into(mut r: impl std::io::Read, into: &Mutex<Vec<u8>>, cap: usize) {
    let mut buf = [0u8; 1024];
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let Ok(mut v) = into.lock() else { return };
        v.extend_from_slice(&buf[..n]);
        if v.len() > cap {
            let cut = v.len() - cap;
            v.drain(..cut);
        }
    }
}

/// Starts Claude and the thread that reads it. `listener` gets each view
/// event, then `{"type":"exited"}` when the process ends.
fn spawn(id: &str, argv: &[String], cwd: &Path, envs: &[(String, String)], listener: Listener) -> Result<Session> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = crate::pty::child_path() {
        cmd.env("PATH", p);
    }
    for k in crate::pty::inherited_markers(std::env::vars().map(|(k, _)| k)) {
        cmd.env_remove(k);
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    // A group of its own, so that stopping it stops what it started.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    // What Claude (or yolobox) says on stderr, its tail kept: a process that
    // fails to start says why there, and "exited" must carry it.
    let errs: Arc<Mutex<Vec<u8>>> = Arc::default();
    if let Some(stderr) = child.stderr.take() {
        let errs = errs.clone();
        std::thread::spawn(move || tail_into(stderr, &errs, STDERR_TAIL));
    }
    let permissions: Arc<Mutex<HashMap<String, Value>>> = Arc::default();

    let pending = permissions.clone();
    let stdin = Arc::new(Mutex::new(Some(stdin)));
    let input = stdin.clone();
    let id = id.to_string();
    let token = next_token();
    std::thread::spawn(move || {
        // Said once per turn: retries repeat the same failure.
        let mut auth_said = false;
        // Line by line until the process closes its output: a line that is
        // not valid UTF-8 is read leniently rather than taken for the end —
        // the session would be forgotten while Claude still runs, and the
        // next message would start a second one (a second sandbox).
        for line in lines_lossy(BufReader::new(stdout)) {
            // yolobox may print a few lines of its own (image build): not ours.
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if !auth_said && auth_failed(&event) {
                auth_said = true;
                listener(json!({ "type": "auth_failed" }));
                // Retrying cannot help: end the turn now rather than after
                // ten attempts.
                if event["type"] != "result" {
                    if let Ok(mut g) = input.lock() {
                        if let Some(w) = g.as_mut() {
                            let _ = writeln!(w, "{}", interrupt("auth"));
                            let _ = w.flush();
                        }
                    }
                }
            }
            if event["type"] == "result" && auth_said {
                auth_said = false;
                // This process keeps the credentials it started with: the
                // next message starts a new one, with the new sign-in.
                let (id, token) = (id.clone(), token);
                std::thread::spawn(move || {
                    let mine = sessions().lock().unwrap().get(&id).is_some_and(|x| x.token == token);
                    if mine {
                        close(&id);
                    }
                });
            }
            if event["type"] == "control_request" && event["request"]["subtype"] == "can_use_tool" {
                if let Some(rid) = event["request_id"].as_str() {
                    pending.lock().unwrap().insert(rid.to_string(), event["request"].clone());
                }
            }
            if let Some(view) = for_view(&event) {
                listener(view);
            }
        }
        // The session is over for this process; the next message starts another.
        let mine = {
            let mut s = sessions().lock().unwrap();
            if s.get(&id).is_some_and(|x| x.token == token) {
                s.remove(&id)
            } else {
                None
            }
        };
        // Its exit code, said in the terminal view and the console: a
        // session ending by itself must be explainable.
        let code = mine.and_then(|mut s| s.child.wait().ok()).map(|st| st.code());
        let stderr = errs.lock().map(|b| String::from_utf8_lossy(&b).trim().to_string()).unwrap_or_default();
        if let Some(code) = code {
            eprintln!("[chat] Claude ended for {id}: code {code:?}{}", if stderr.is_empty() { String::new() } else { format!("\n{stderr}") });
        }
        listener(json!({ "type": "exited", "code": code.flatten(), "stderr": stderr }));
    });

    Ok(Session {
        child,
        stdin,
        permissions,
        next: 0,
        token,
    })
}

/// Previews Claude looks at: `Read` calls on `preview/*.png`, by tool id,
/// until their result arrives.
#[derive(Default)]
struct Glances(HashMap<String, PathBuf>);

impl Glances {
    /// Notes the `Read` calls of an assistant event that open a preview.
    fn watch(&mut self, ws: &Path, event: &Value) {
        if event["type"] != "assistant" {
            return;
        }
        for b in event["message"]["content"].as_array().into_iter().flatten() {
            let path = b["input"]["file_path"].as_str().map(PathBuf::from);
            let Some(path) = path.filter(|_| b["type"] == "tool_use" && b["name"] == "Read") else {
                continue;
            };
            let preview = crate::ia::previews_dir_of(ws);
            if path.parent() == Some(preview.as_path()) && path.extension().is_some_and(|e| e == "png") {
                if let Some(id) = b["id"].as_str() {
                    self.0.insert(id.to_string(), path);
                }
            }
        }
    }

    /// For the tool results of a user event: the preview as Claude saw it,
    /// copied into `attachments/` (the preview itself changes with the next
    /// version), as a `seen` event for the view and the log.
    fn seen(&mut self, ws: &Path, event: &Value) -> Vec<Value> {
        if event["type"] != "user" {
            return Vec::new();
        }
        let mut out = Vec::new();
        for b in event["message"]["content"].as_array().into_iter().flatten() {
            let Some(tid) = b["tool_use_id"].as_str() else { continue };
            let Some(src) = self.0.remove(tid) else { continue };
            if b["is_error"] == true {
                continue;
            }
            let safe: String = tid.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            let name = format!("seen-{safe}.png");
            let dir = attachments_dir(ws);
            if std::fs::create_dir_all(&dir).is_ok() && std::fs::copy(&src, dir.join(&name)).is_ok() {
                out.push(json!({ "type": "seen", "tool_use_id": tid, "name": name }));
            }
        }
        out
    }
}

/// The listener of a conversation in the app: to the view, and to the log.
fn app_listener(app: &AppHandle, id: &str) -> Listener {
    let app = app.clone();
    let id = id.to_string();
    let ws = crate::ia::workspace(&id);
    let glances = Mutex::new(Glances::default());
    Arc::new(move |event: Value| {
        let mut events = vec![event];
        {
            let mut g = glances.lock().unwrap();
            g.watch(&ws, &events[0]);
            let seen = g.seen(&ws, &events[0]);
            events.extend(seen);
        }
        let kept: Vec<Value> = events.iter().filter(|e| logged(e) && e["type"] != "exited").cloned().collect();
        log_append(&ws, &kept);
        if events[0]["type"] == "exited" {
            crate::ia::watch_stop(&id);
        }
        let _ = app.emit("ia-chat", json!({ "id": id, "events": events }));
    })
}

/// Starts the conversation's Claude if it is not running.
/// The lines of a stream until its end, invalid UTF-8 replaced rather than
/// ending the reading.
fn lines_lossy(mut r: impl BufRead) -> impl Iterator<Item = String> {
    let mut buf = Vec::new();
    std::iter::from_fn(move || {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => None,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                Some(String::from_utf8_lossy(&buf).into_owned())
            }
        }
    })
}

fn ensure_started(app: &AppHandle, c: &Conversation) -> Result<()> {
    // Two simultaneous messages would start two Claudes on one session.
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _gate = GATE.get_or_init(|| Mutex::new(())).lock().unwrap();
    if is_open(&c.id) {
        return Ok(());
    }
    let ws = crate::ia::workspace(&c.id);
    if !ws.is_dir() {
        return Err(anyhow!(crate::t!("err.no_workspace")));
    }
    crate::ia::refresh_workspace(&c.id);
    let argv = command_line(c, &Tools::detect(), crate::ia::has_session(&c.id))?;
    let envs = crate::auth::sandbox_env(&c.engine);
    let session = spawn(&c.id, &argv, &ws, &envs, app_listener(app, &c.id))?;
    sessions().lock().unwrap().insert(c.id.clone(), session);
    // What Claude writes is watched while it runs, as with the terminal.
    let _ = crate::ia::watch_start(app.clone(), &c.id);
    crate::ia::mark_started(&c.id);
    Ok(())
}

fn write_line(id: &str, message: &Value) -> Result<()> {
    let stdin = {
        let s = sessions().lock().unwrap();
        s.get(id).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?.stdin.clone()
    };
    let mut g = stdin.lock().unwrap();
    let w = g.as_mut().ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
    writeln!(w, "{message}")?;
    w.flush()?;
    Ok(())
}

/// Sends a message, starting Claude first if needed. The message is logged
/// before it leaves, with its attachments saved in the workspace.
pub fn send(app: &AppHandle, c: &Conversation, text: &str, images: &[Attachment]) -> Result<()> {
    ensure_started(app, c)?;
    let ws = crate::ia::workspace(&c.id);
    log_append(&ws, &[save_attachments(&ws, text, images)]);
    if let Err(e) = write_line(&c.id, &user_message(text, images)) {
        close(&c.id);
        return Err(e);
    }
    Ok(())
}

/// Interrupts the current turn; the process stays for the next message.
pub fn stop(id: &str) -> Result<()> {
    let rid = {
        let mut s = sessions().lock().unwrap();
        let Some(sess) = s.get_mut(id) else { return Ok(()) };
        sess.next += 1;
        format!("interrupt-{}", sess.next)
    };
    write_line(id, &interrupt(&rid))
}

/// Answers a permission request, and logs the answer for the history.
pub fn answer(id: &str, request_id: &str, allow: bool, always: bool, input: Option<Value>) -> Result<()> {
    let request = {
        let s = sessions().lock().unwrap();
        let sess = s.get(id).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
        let r = sess.permissions.lock().unwrap().remove(request_id);
        r.unwrap_or(Value::Null)
    };
    let deny = crate::t!("chat.denied_by_user");
    write_line(id, &permission_response(request_id, &request, allow, always, input.as_ref(), &deny))?;
    let answers = input.as_ref().map(|i| i["answers"].clone()).unwrap_or(Value::Null);
    log_append(
        &crate::ia::workspace(id),
        &[json!({ "type": "permission_answer", "request_id": request_id, "allow": allow, "always": always, "answers": answers })],
    );
    Ok(())
}

/// Switches the conversation's model: kept for its next starts, and applied
/// at once to a running session (`set_model`, as the Agent SDK does).
/// `None`: back to the account's default.
pub fn set_model(id: &str, model: Option<&str>) -> Result<()> {
    if let Some(m) = model {
        if !MODELS.contains(&m) {
            return Err(anyhow!("unknown model: {m}"));
        }
    }
    let mut c = crate::ia::get(id)?;
    c.model = model.map(String::from);
    crate::ia::save(&c)?;
    if is_open(id) {
        let rid = {
            let mut s = sessions().lock().unwrap();
            let sess = s.get_mut(id).ok_or_else(|| anyhow!(crate::t!("err.terminal_closed")))?;
            sess.next += 1;
            format!("model-{}", sess.next)
        };
        let mut request = json!({ "subtype": "set_model" });
        if let Some(m) = model {
            request["model"] = json!(m);
        }
        write_line(id, &json!({ "type": "control_request", "request_id": rid, "request": request }))?;
    }
    Ok(())
}

/// Something of ours in the log, such as a new version of the object.
pub fn note(id: &str, event: Value) {
    let ws = crate::ia::workspace(id);
    if ws.is_dir() {
        log_append(&ws, &[event]);
    }
}

/// Time left to Claude to finish on its own once its input ends.
const GRACE: std::time::Duration = std::time::Duration::from_millis(2500);
/// Then, time left to the group after SIGTERM: yolobox relays it to stop
/// its container, which a SIGKILL right after would leave running.
const TERM_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// True once the child has ended (or cannot be asked), false past `d`.
fn ended_within(child: &mut Child, d: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + d;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return true,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(80)),
            Ok(None) => return false,
        }
    }
}

/// Ends the conversation's Claude. Nothing is lost: the next message resumes
/// the session from the transcript.
pub fn close(id: &str) {
    let Some(mut sess) = sessions().lock().unwrap().remove(id) else {
        return;
    };
    crate::ia::watch_stop(id);
    // Ask first: interrupt the turn, then end the input. Taking the handle
    // out of the shared slot is what closes the pipe (the reader thread
    // holds the slot too); Claude then ends on its own.
    if let Ok(mut g) = sess.stdin.lock() {
        if let Some(w) = g.as_mut() {
            let _ = writeln!(w, "{}", interrupt("closing"));
            let _ = w.flush();
        }
        *g = None;
    }
    if ended_within(&mut sess.child, GRACE) {
        return;
    }
    #[cfg(unix)]
    {
        unsafe {
            // SAFETY: plain signal to the process group we created.
            libc::killpg(sess.child.id() as i32, libc::SIGTERM);
        }
        if ended_within(&mut sess.child, TERM_GRACE) {
            return;
        }
    }
    let _ = sess.child.kill();
    let _ = sess.child.wait();
}

/// Ends every conversation's Claude — when the app closes.
pub fn close_all() {
    let ids: Vec<String> = sessions()
        .lock()
        .map(|s| s.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        close(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_invalid_line_does_not_end_the_reading() {
        let data: &[u8] = b"{\"a\":1}\r\n\xff\xfe garbage\n{\"b\":2}\n";
        let lines: Vec<String> = lines_lossy(data).collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "{\"a\":1}");
        assert!(lines[1].ends_with(" garbage"));
        assert_eq!(lines[2], "{\"b\":2}");
    }

    const STREAM: &str = include_str!("../tests/fixtures/chat-stream.jsonl");
    const TRANSCRIPT: &str = include_str!("../tests/fixtures/chat-transcript.jsonl");

    fn conv(engine: &str) -> Conversation {
        let mut c = crate::ia::tests_conversation();
        c.engine = engine.into();
        c
    }

    fn tools() -> Tools {
        Tools {
            claude: Some("/usr/local/bin/claude".into()),
            yolobox: Some("/usr/local/bin/yolobox".into()),
        }
    }

    #[test]
    fn sign_in_failures_are_recognized() {
        // As Claude Code 2.1.286 prints them with a dead token.
        let retry = json!({ "type": "system", "subtype": "api_retry", "attempt": 1, "error_status": 401, "error": "authentication_failed" });
        let result = json!({ "type": "result", "is_error": true, "result": "Failed to authenticate. API Error: 401 OAuth access token is invalid." });
        assert!(auth_failed(&retry));
        assert!(auth_failed(&result));
        let overloaded = json!({ "type": "system", "subtype": "api_retry", "error_status": 529, "error": "overloaded" });
        assert!(!auth_failed(&overloaded));
        assert!(!auth_failed(&json!({ "type": "result", "is_error": false, "result": "Failed to authenticate is a phrase" })));
        assert!(!logged(&json!({ "type": "auth_failed" })));
    }

    #[test]
    fn local_command_line() {
        let argv = command_line(&conv("local"), &tools(), false).unwrap();
        assert_eq!(argv[0], "/usr/local/bin/claude");
        assert_eq!(&argv[1..10], &CLI_ARGS.map(String::from));
        assert!(argv.windows(2).any(|w| w[0] == "--session-id"));
        assert!(argv.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
        let resumed = command_line(&conv("local"), &tools(), true).unwrap();
        assert!(resumed.windows(2).any(|w| w[0] == "--resume"));
        assert!(!resumed.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn the_chosen_model_is_passed() {
        let mut c = conv("local");
        assert!(!command_line(&c, &tools(), false).unwrap().contains(&"--model".to_string()));
        c.model = Some("claude-sonnet-5-5".into());
        let argv = command_line(&c, &tools(), true).unwrap();
        let at = argv.iter().position(|a| a == "--model").expect("--model");
        assert_eq!(argv[at + 1], "claude-sonnet-5-5");
        // Only known models reach the command line.
        c.model = Some("--dangerously-skip-permissions".into());
        assert!(!command_line(&c, &tools(), false).unwrap().contains(&"--model".to_string()));
    }

    #[test]
    fn container_command_line() {
        let argv = command_line(&conv("container"), &tools(), false).unwrap();
        assert_eq!(&argv[..2], ["/usr/local/bin/yolobox", "claude"]);
        let p = argv.iter().position(|a| a == "-p").unwrap();
        assert!(argv.iter().position(|a| a == "--claude-config").unwrap() < p, "yolobox flags first");
        assert!(!argv.iter().any(|a| a == "--permission-mode"), "the sandbox grants permissions");
        assert!(!argv.iter().any(|a| a == "--"), "no separator");
    }

    #[test]
    fn a_permission_is_answered_as_claude_asks() {
        let request = json!({ "input": { "command": "ls" }, "permission_suggestions": [{ "type": "addRules" }] });
        let allowed = permission_response("r1", &request, true, false, None, "no");
        assert_eq!(allowed["response"]["request_id"], "r1");
        assert_eq!(allowed["response"]["response"]["updatedInput"]["command"], "ls");
        assert!(allowed["response"]["response"].get("updatedPermissions").is_none());
        let always = permission_response("r1", &request, true, true, None, "no");
        assert_eq!(always["response"]["response"]["updatedPermissions"][0]["type"], "addRules");
        let denied = permission_response("r1", &request, false, false, None, "no");
        assert_eq!(denied["response"]["response"], json!({ "behavior": "deny", "message": "no" }));
        let answered = json!({ "questions": [], "answers": { "Red or blue?": "Blue" } });
        let ask = permission_response("r2", &request, true, false, Some(&answered), "no");
        assert_eq!(ask["response"]["response"]["updatedInput"]["answers"]["Red or blue?"], "Blue");
    }

    #[test]
    fn status_events_stay_out_of_the_view() {
        // Nothing sets a mode any more: a status, with or without a mode, is
        // not the view's business.
        assert!(for_view(&json!({ "type": "system", "subtype": "status", "status": null, "permissionMode": "plan" })).is_none());
        assert!(for_view(&json!({ "type": "system", "subtype": "status", "status": "requesting" })).is_none());
    }

    #[test]
    fn a_message_carries_its_images_first() {
        let img = Attachment { name: "a.png".into(), media_type: "image/png".into(), data: "AAAA".into() };
        let m = user_message("look", &[img]);
        let c = &m["message"]["content"];
        assert_eq!(c[0]["type"], "image");
        assert_eq!(c[0]["source"]["data"], "AAAA");
        assert_eq!(c[1]["text"], "look");
    }

    /// The recorded stream, as the view gets it: no bookkeeping, deltas only
    /// as text, permission requests slim but complete enough to answer.
    #[test]
    fn the_recorded_stream_is_slimmed_for_the_view() {
        let events: Vec<Value> = STREAM.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let view: Vec<Value> = events.iter().filter_map(for_view).collect();
        let count = |ty: &str| view.iter().filter(|e| e["type"] == ty).count();
        assert_eq!(count("result"), 4, "three turns, one interrupted, then the resume");
        assert_eq!(count("control_request"), 1);
        assert!(view.iter().all(|e| e["type"] != "system" || e["subtype"] == "init"));
        assert!(view.iter().all(|e| e["type"] != "rate_limit_event"));
        let perm = view.iter().find(|e| e["type"] == "control_request").unwrap();
        assert_eq!(perm["request"]["tool_name"], "Bash");
        assert_eq!(perm["request"]["can_always"], true);
        let text: String = view
            .iter()
            .filter(|e| e["type"] == "stream_event")
            .filter_map(|e| e["event"]["delta"]["text"].as_str())
            .collect();
        assert!(text.contains("hello from file"));
        let s = serde_json::to_string(&view).unwrap();
        assert!(!s.contains("signature"), "thinking signatures stay out");
        assert!(!s.contains("tool_use_result"));
    }

    #[test]
    fn the_transcript_becomes_a_history() {
        let h = from_transcript(TRANSCRIPT);
        assert!(h.iter().all(|e| e["message"]["content"].is_array() || e["type"] == "result"));
        let texts: Vec<String> = h
            .iter()
            .flat_map(|e| e["message"]["content"].as_array().cloned().unwrap_or_default())
            .filter_map(|b| b["text"].as_str().map(String::from))
            .collect();
        assert!(texts.iter().any(|t| t.contains("hello from file")));
        assert!(!texts.iter().any(|t| t == "a sub-agent's turn"), "sub-agents stay out");
        assert!(!texts.iter().any(|t| t == "<meta>"), "meta records stay out");
        assert!(!texts.iter().any(|t| t == "No response requested."));
        assert!(!texts.iter().any(|t| t == INTERRUPTED));
        assert_eq!(h.iter().filter(|e| e["type"] == "result").count(), 1, "the interrupt shows as stopped");
    }

    #[test]
    fn the_log_is_the_history_once_it_exists() {
        let ws = std::env::temp_dir().join(format!("snapstudio-chat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(&ws).unwrap();
        let tr = ws.join("t.jsonl");
        std::fs::write(&tr, TRANSCRIPT).unwrap();
        assert!(!history_of(&ws, Some(&tr)).is_empty(), "no log yet: the transcript");

        let img = Attachment { name: "../../evil sketch.png".into(), media_type: "image/png".into(), data: "iVBORw0K".into() };
        let msg = save_attachments(&ws, "hello", &[img]);
        log_append(&ws, &[msg, json!({ "type": "result", "subtype": "success" })]);
        let h = history_of(&ws, Some(&tr));
        assert_eq!(h.len(), 2, "the log wins over the transcript");
        let name = h[0]["message"]["content"][0]["name"].as_str().unwrap();
        assert_eq!(name, "001-evil-sketch.png", "no path, no spaces");
        assert!(attachments_dir(&ws).join(name).is_file());
        assert!(!log_path(&ws).with_file_name("x").exists());
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Writes the recorded stream as the view gets it, for the UI tests:
    /// `CHAT_VIEW_OUT=/tmp/chat-view.json cargo test dump_view_events -- --ignored`.
    #[test]
    #[ignore]
    fn dump_view_events() {
        let view: Vec<Value> = STREAM
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter_map(|e| for_view(&e))
            .collect();
        let out = std::env::var("CHAT_VIEW_OUT").unwrap_or_else(|_| "/tmp/chat-view.json".into());
        std::fs::write(out, serde_json::to_string(&view).unwrap()).unwrap();
        std::fs::write("/tmp/chat-history.json", serde_json::to_string(&from_transcript(TRANSCRIPT)).unwrap()).unwrap();
    }

    #[test]
    fn previews_claude_reads_are_kept_as_seen() {
        let ws = std::env::temp_dir().join(format!("snapstudio-glance-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        let preview = crate::ia::previews_dir_of(&ws);
        std::fs::create_dir_all(&preview).unwrap();
        std::fs::write(preview.join("front.png"), b"png").unwrap();
        let mut g = Glances::default();
        let read = |id: &str, path: &Path| json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": id, "name": "Read", "input": { "file_path": path } } ] } });
        g.watch(&ws, &read("toolu_1", &preview.join("front.png")));
        g.watch(&ws, &read("toolu_2", &ws.join("model.py")));
        let result = |id: &str| json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "tool_use_id": id, "content": [{ "type": "image" }] } ] } });
        let seen = g.seen(&ws, &result("toolu_1"));
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["name"], "seen-toolu_1.png");
        assert!(attachments_dir(&ws).join("seen-toolu_1.png").is_file());
        assert!(g.seen(&ws, &result("toolu_2")).is_empty(), "not a preview");
        assert!(g.seen(&ws, &result("toolu_1")).is_empty(), "only once");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn long_tool_results_are_capped() {
        let big = "x".repeat(RESULT_CAP + 10);
        let c = slim_content(&json!([{ "type": "tool_result", "tool_use_id": "t", "content": big }]));
        assert_eq!(c[0]["content"].as_str().unwrap().chars().count(), RESULT_CAP + 1);
    }

    /// The whole loop against the real Claude Code (costs a few cents):
    /// `CHAT_REAL=1 cargo test --lib real_claude_round_trip -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_claude_round_trip() {
        if std::env::var("CHAT_REAL").is_err() {
            return;
        }
        let ws = std::env::temp_dir().join(format!("snapstudio-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        std::fs::create_dir_all(&ws).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut argv: Vec<String> = vec![crate::util::which("claude").unwrap().to_string_lossy().to_string()];
        argv.extend(CLI_ARGS.iter().map(|s| s.to_string()));
        argv.extend(["--model", "haiku", "--session-id", &id].map(String::from));
        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = got.clone();
        let sess = spawn(&id, &argv, &ws, &[], Arc::new(move |e| sink.lock().unwrap().push(e))).unwrap();
        sessions().lock().unwrap().insert(id.clone(), sess);
        let wait = |pred: &dyn Fn(&[Value]) -> bool| {
            let end = std::time::Instant::now() + std::time::Duration::from_secs(120);
            while !pred(&got.lock().unwrap()) && std::time::Instant::now() < end {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        };
        write_line(&id, &user_message("Run `echo real-ok > proof.txt` with the Bash tool, then say done.", &[])).unwrap();
        wait(&|e| e.iter().any(|x| x["type"] == "control_request"));
        let rid = got.lock().unwrap().iter().find(|x| x["type"] == "control_request").unwrap()["request_id"]
            .as_str()
            .unwrap()
            .to_string();
        answer(&id, &rid, true, false, None).unwrap();
        wait(&|e| e.iter().any(|x| x["type"] == "result"));
        assert_eq!(std::fs::read_to_string(ws.join("proof.txt")).unwrap().trim(), "real-ok");
        close(&id);
        let events = got.lock().unwrap().clone();
        println!("{} view events; types: {:?}", events.len(), events.iter().map(|e| e["type"].as_str().unwrap_or("")).collect::<std::collections::BTreeSet<_>>());
        assert!(events.iter().any(|x| x["type"] == "result"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// The whole loop against a fake Claude: a script that answers each
    /// message with one assistant line and a result, and echoes interrupts.
    #[cfg(unix)]
    #[test]
    fn a_session_talks_with_a_fake_claude() {
        let dir = std::env::temp_dir().join(format!("snapstudio-fake-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("claude");
        std::fs::write(
            &fake,
            r#"#!/bin/sh
echo 'not json, ignored'
while IFS= read -r line; do
  case "$line" in
    *interrupt*) echo '{"type":"result","subtype":"error_during_execution","is_error":true}' ;;
    *) echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"pong"}]}}'
       echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01}' ;;
  esac
done
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        let got: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = got.clone();
        let id = "fake-session";
        let sess = spawn(id, &[fake.to_string_lossy().to_string()], &dir, &[], Arc::new(move |e| sink.lock().unwrap().push(e))).unwrap();
        sessions().lock().unwrap().insert(id.into(), sess);
        write_line(id, &user_message("ping", &[])).unwrap();
        stop(id).unwrap();
        let wait_for = |n: usize| {
            let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while got.lock().unwrap().len() < n && std::time::Instant::now() < end {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        wait_for(3);
        close(id);
        // Closing interrupts first: the fake may answer that interrupt with
        // one more result before it exits. Wait for the end itself.
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while got.lock().unwrap().last().is_none_or(|e| e["type"] != "exited") && std::time::Instant::now() < end {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let events = got.lock().unwrap().clone();
        assert_eq!(events[0]["message"]["content"][0]["text"], "pong");
        assert_eq!(events[1]["subtype"], "success");
        assert_eq!(events[2]["subtype"], "error_during_execution");
        assert_eq!(events.last().unwrap()["type"], "exited");
        assert!(!is_open(id));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
