# AI conversations as a real chat view

Replace the raw Claude Code terminal of the AI tab with a clean conversation
view — streamed Markdown answers, tool cards, permission buttons, Stop,
images — while keeping every Claude Code capability. The terminal stays
available as an "advanced" view of the same session.

Inspired by [simscorpbs/claude-chat-panel](https://github.com/simscorpbs/claude-chat-panel)
(MIT): its protocol notes, its Rust host (`hosts/rust/src/lib.rs`, ~300 lines,
`serde_json` only) and its page (`web/chat.js`, ~330 lines). We adapt them to
Snap Studio instead of embedding the panel as is: our UI is vanilla JS in the
main web view, with our i18n, design tokens and Tauri events.

## Why not parse the terminal

Claude Code has an official structured mode, the one the Agent SDK and the
IDE extensions use. Parsing the TUI would break on every Claude Code release;
the structured mode is a documented contract.

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --permission-prompt-tool stdio \
       (--session-id <uuid> | --resume <uuid>) [our flags]
```

One JSON object per line on stdin and stdout; stderr discarded. The
conversation id stays the session id, exactly as today, so resuming, the
transcript in `~/.claude/projects/<slug>/<id>.jsonl` and `ia::has_session`
keep working unchanged.

## The protocol (from claude-chat-panel's PROTOCOL.md)

**Host → CLI**

| What | Line |
|---|---|
| User message | `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}` — `content` may also carry `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}` |
| Stop | `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}` |
| Allow | `{"type":"control_response","response":{"subtype":"success","request_id":"<req>","response":{"behavior":"allow","updatedInput":<input>}}}` (+ `"updatedPermissions": <permission_suggestions>` for "Always allow") |
| Deny | same, with `{"behavior":"deny","message":"…"}` |

**CLI → host** (forwarded to the UI; the rest is bookkeeping)

| `type` | Meaning |
|---|---|
| `system` / `init` | Session started: `model`, tools, `capabilities` |
| `stream_event` | Streaming piece (`content_block_delta` / `text_delta`, `thinking_delta`) |
| `assistant` | Whole turn: `text`, `thinking` and `tool_use` blocks |
| `user` | `tool_result` blocks |
| `control_request` / `can_use_tool` | Permission asked: keep `input` and `permission_suggestions` by `request_id` |
| `result` | Turn over: `total_cost_usd`, `is_error`, `subtype` |

Plus two host events: `exited` (process ended) and `error` (could not start).

## Target design

```
ui/ia-chat.js  ⇄  Tauri commands / "ia-chat" event  ⇄  src-tauri/src/chat.rs  ⇄  claude (stream-json)
                                                         (yolobox claude … in container mode)
```

- **`src-tauri/src/chat.rs`** — adapted from the panel's Rust host: one
  `Session` per conversation (spawn on first message, `--session-id` or
  `--resume`, reader thread, pending permissions map, interrupt, close),
  `history()` from the transcript. Events go to the UI as
  `app.emit("ia-chat", { id, events })`, batched per read burst. Our
  existing launch logic moves here from `pty.rs`: tool discovery, `PATH`
  completion, inherited-session env scrubbing (`CLAUDECODE`…), yolobox argv,
  folder watch start, `mark_started`, `refresh_workspace`.
- **Commands**: `ia_chat_open(id)` → history, `ia_chat_send(id, text,
  images)`, `ia_chat_stop(id)`, `ia_chat_perm(id, request_id, allow,
  always)`, `ia_chat_close(id)`.
- **`ui/ia-chat.js`** — adapted from the panel's `chat.js`: user bubbles,
  streamed assistant Markdown (rAF-throttled), collapsible tool rows with
  results, permission cards, working indicator, Stop/Send swap, Esc to stop,
  copy buttons, cost and model in the status line, history replay. Strings
  through `tr()`, styles from our tokens in `style.css`, links opened with the
  opener plugin.
- **Markdown**: vendored `marked` (MIT) + `DOMPurify` (Apache-2.0/MPL-2.0)
  in `ui/vendor/`, like xterm; allowed by our CSP (`script-src 'self'`).
  Sanitizing is mandatory: tool results and web content can carry HTML.

### Our own conversation log in the workspace

Claude's transcript (`~/.claude/projects/<slug>/<id>.jsonl`) stays the
source of truth for **resuming**: we never write into it. Next to it, each
conversation keeps what the view shows, in its working folder:

```
workspace/
  chat.jsonl          ← one JSON line per displayed event, append-only
  attachments/        ← images the user attached (sketches, photos)
```

- **Why**: Claude Code deletes old transcripts (`cleanupPeriodDays`, 30 days
  by default — to confirm in the spike), while a conversation must live as
  long as its object; the transcript also lacks what is ours (version chips,
  attachments, permission decisions); and the conversation folder then holds
  everything, so deleting or moving it is complete.
- **What is written**: the user's messages (text + attachment file names, not
  base64), the CLI events the view keeps (`assistant`, `user` tool results,
  `result`, permission requests and our answers), and our own events
  (`version` when `ia-mesh` archives a version, `exited`, `error`). Streaming
  deltas (`stream_event`) are **not** stored: the final `assistant` message
  replaces them.
- **Replay**: `ia_chat_open` returns `chat.jsonl`; when it is missing (a
  conversation from before this plan), the transcript is converted instead,
  as the panel's `history()` does.
- **Size**: tool results are capped (the panel keeps 20 000 characters);
  image tool results stay references to `preview/` files, not data.
- **Outside Claude's reach**: `CLAUDE.md` tells Claude not to touch
  `chat.jsonl` or `attachments/`, like `versions/`.

### Snap Studio additions (beyond the panel)

- **Version chips**: a `Bash` tool row running `tools/export.py` shows
  "v3 installed" when the matching `ia-mesh` event arrives; clicking it
  selects that version in the right pane.
- **Preview thumbnails**: a `Read` of `preview/*.png` shows the image in the
  tool row (from the `tool_result` image block), so the user sees what Claude
  looked at.
- **Images in, from the composer**: paste, drop or pick a sketch/photo; sent
  as base64 `image` blocks (size-capped, downscaled to ~1568 px).
- **Thinking**: shown as a collapsed "Thinking…" row when present.
- **Mode switch**: permission mode (ask / accept edits / plan) via a
  `set_permission_mode` control request — to verify against the CLI; fallback
  is restarting the process with `--permission-mode`.
- **Initial prompt**: becomes the first user message (no more argv prompt),
  shown as the first bubble.
- **No trust dialog**: `-p` shows no workspace-trust prompt, so the
  "answer Yes, I trust this folder" hint goes away.

### The terminal stays, as "Terminal" view

A segmented control in the AI toolbar: **Conversation | Terminal**. Both use
the same session id, but never at the same time: switching closes one process
before the other resumes the transcript. The terminal remains the escape
hatch for interactive-only commands (`/login`, `/config` UI…).

## Risks to settle first

1. **yolobox without a TTY** — container mode today runs through a PTY.
   `yolobox claude -p …` must accept piped stdin/stdout (no `docker -t`). If
   it insists on a TTY: run it in the PTY anyway, disable echo (`stty -echo`
   or raw mode) and read JSON lines from the PTY, stripping `\r`.
2. **Permissions in the container** — the sandbox already grants full
   permissions, so no `can_use_tool` requests appear there; the cards only
   matter in local mode (today `--permission-mode acceptEdits`, Bash still
   asks).
3. **Protocol drift** — `--permission-prompt-tool stdio` and the control
   messages are what the SDK uses but are thinly documented. Read the
   `system/init` `capabilities`, ignore unknown event types, and keep the
   terminal view as fallback.
4. **Auth** — `-p` uses the same login as the interactive CLI (subscription
   or API key); do **not** pass `--bare`, which skips OAuth and CLAUDE.md.

## Spike results (step 1, Claude Code 2.1.292)

Recorded in `src-tauri/tests/fixtures/chat-stream.jsonl` (live stream: text,
`Read`, a `Bash` permission, an interrupt, then a resume in a second process)
and `chat-transcript.jsonl` (the matching transcript), scrubbed of account
data.

- **Works as documented**: streaming deltas, tool use and results, the
  `can_use_tool` request answered with `control_response`, interrupt, resume
  with `--resume <id>` from another process.
- **One assistant message comes in several `assistant` events**, one per
  content block (`thinking`, then `tool_use` or `text`), sharing
  `message.id`.
- **Thinking is redacted**: `thinking` blocks arrive with an empty text and a
  signature; only `system/thinking_tokens` estimates show. The view can only
  say "Thinking…".
- **`system/init` comes at every turn**, not once; `system/status`
  (`requesting`) precedes each request.
- **Interrupt**: the CLI answers `control_response` (`still_queued`), emits a
  `user` text `[Request interrupted by user]`, then `result` with
  `subtype: error_during_execution`. The transcript then holds an assistant
  "No response requested." — hide both in history.
- **`total_cost_usd` is cumulative** for the process, not per turn.
- **Risk 1 settled — no PTY**: behind a TTY, `claude -p` refuses stream-json
  input ("Input must be provided either through stdin…"). Pipes are required.
  yolobox (finbarr/yolobox, `shouldAttachTTY`) runs Docker with `-i` and no
  `-t` when stdin/stdout are not terminals, so `yolobox claude -p …` with
  pipes works; its `claude` alias adds `--dangerously-skip-permissions`, so no
  permission request comes from the container (risk 2). Non-JSON lines from
  yolobox (image build) are possible on stdout: ignore them, show a "starting
  the sandbox" note instead.
- **`cleanupPeriodDays`** does delete transcripts after its delay: our own
  `chat.jsonl` is needed for long-lived conversations.

## Done (steps 2–7)

- `src-tauri/src/chat.rs`: Claude in stream-json mode behind pipes, local or
  through yolobox; reader thread with a per-process token; permission
  answers (with `AskUserQuestion` answers); interrupt; permission mode at once
  (`set_permission_mode`) or at the next start; graceful close (interrupt,
  end of input, then the process group); `chat.jsonl` log, `attachments/`,
  previews Claude read kept as `seen-*.png`; history from the log or the
  transcript. Commands `ia_chat_history/send/stop/answer/mode/running/close`.
- `ui/ia-chat.js`: the view (streamed Markdown through marked + DOMPurify,
  tool rows, permission / question / plan cards, version chips, preview
  thumbnails, image attachments by button, paste or drop, Stop/Esc, mode
  menu, model and cost), in both languages.
- Conversation | Terminal switch: one process per session, the other view's
  process ends first.
- Tests: Rust units on the recorded fixtures, a fake Claude, and an opt-in
  round trip with the real CLI (`CHAT_REAL=1 cargo test --lib
  real_claude_round_trip -- --ignored`); browser harness replaying the
  fixture in both languages.
- Not done on purpose: a "Thinking…" row (thinking is redacted in the
  stream, the working dots say enough); the chosen permission mode is not
  kept across app restarts.

## Claude sign-in (added after testing on the Mac)

Why the sandbox lost its sign-in: on macOS Claude Code keeps its OAuth login
in the Keychain; yolobox `--claude-config` copies it into the container at
every start. Access tokens last about 8 h and the refresh token rotates, so
the Mac and the container hold two copies of one rotating token: whichever
renews second gets refused, and the Mac itself can end up signed out.
`claude auth status` does not tell (it reads the file, never asks the
server).

- `src-tauri/src/auth.rs`: the sandbox gets a token of its own,
  `claude setup-token` (one year, tied to the subscription), stored in the
  Keychain (`fr.carlini.snapstudio.claude-sandbox`, written through
  `security -i` so the token never shows in the process list; a 0600 file
  elsewhere), passed to yolobox as `CLAUDE_CODE_OAUTH_TOKEN` — yolobox
  forwards it and it takes precedence over the copied login (checked:
  `authMethod: oauth_token`). Status (`claude auth status --json`), real
  check (one Haiku call, streamed, stopped at the first 401 — 8 s instead of
  Claude's ten retries), sign-in terminal (`claude auth login`,
  `claude setup-token` with the printed token caught and stored).
- `chat.rs`: a 401 retry (`api_retry` / `authentication_failed`) or a
  "Failed to authenticate" result sends `auth_failed` to the view (not
  logged), interrupts the turn, and closes the process after its result so
  the next message starts with the new credentials. The terminal view only
  shows Claude's own message.
- `ui/auth.js`: "Claude account" window — this Mac (state, Check, Sign In
  Again) and the sandbox (own token or copy, Check, Create / Replace the
  Token, Forget, paste a token), with a small terminal; opened by the chat on
  `auth_failed` and from Settings → AI.
- Tests: units (token recognition, capture through colors and chunks,
  failure signatures, check verdicts); opt-in real runs
  (`AUTH_REAL=1 cargo test --lib real_ -- --ignored --nocapture`), including
  a dead sandbox token refused in the container and the Keychain left clean.
- To check on the Mac: the full `setup-token` flow in the window (browser,
  token caught), then a container conversation with it.

## Multicolor 3MF results (added after testing on the Mac)

The AI workspace used to be STL from end to end: the original was melted
into one `source.stl`, results and versions were STL, the save converted
back to a one-color 3MF. Colors and heads were lost both ways.

- Everything is 3MF now: `source.3mf` (the original split per head, each
  head's filament color on uncolored triangles), `out/current.3mf`,
  `versions/vN.3mf`; previews and the 3D pane in the parts' colors; the save
  copies the file as is; slicing maps the parts' heads, with the parts'
  colors when the file has no project filaments (`slice::part_colors`).
- `src-tauri/src/ia_tools/`: `mf.py` (`read` / `write` of parts — name,
  color, head, trimesh mesh — in `write_multipart`'s layout, written
  atomically), `export.py` (`result.3mf`, or `file.stl[:color[:head]]`…;
  checks, warns beyond 4 heads, waits for the new previews), `measure.py`
  (part by part), and the `export-3mf` skill in `.claude/skills/` (found by
  Claude Code in `-p` mode, checked). `CLAUDE.md` holds the short rules:
  always 3MF, keep the current parts' colors and heads, no overlap between
  colors.
- Older conversations: source and current state converted to one-part 3MF
  when opened; old `vN.stl` versions stay listed and restorable.
- Tests: Rust units (multicolor original kept through save and slicing
  info, filament colors, migration, a fixture written by `mf.py`); opt-in
  `SS_PYTHON=… cargo test --lib python_tools -- --ignored` (the real tools)
  and `IA_REAL=1 cargo test --lib real_container_multicolor -- --ignored`
  (a real Claude in the sandbox designed a white tag with an inlaid black
  stripe: two parts, two heads, no overlap).
- Left: part names are lost on the app side (its reader flattens the mesh,
  so `source.3mf` parts are named `part-<head>`); painted models (Orca's
  brush) still arrive in one color.

## To check on the Mac

- Container mode end to end through yolobox (pipes, no TTY; first image
  rebuild because the Dockerfile text changed).
- macOS: `killpg` on close, attachments served by `thumb://`, paste of a
  screenshot into the composer.

## Steps

Each step ends with tests and a check on the Mac.

1. **Spike** — run the exact command line by hand, locally and through
   yolobox, with piped stdio: record a real stream (text, tool use, a
   permission, an interrupt, a resume) into `src-tauri/tests/fixtures/` for
   the tests below. Settle risks 1–3, and check `cleanupPeriodDays`.
2. **`chat.rs`** — port the panel's host: argv, session start/resume,
   reader thread, permission map, interrupt, close, history from the
   transcript; then our launch logic from `pty.rs`; the `chat.jsonl` log and
   `attachments/`. Unit tests: permission answers, event filtering, history
   filtering (`isSidechain`, `isMeta`), log writing and replay (with the
   transcript fallback), replay of the recorded fixture.
3. **Commands and events** — `ia_chat_*` commands, `ia-chat` event batching,
   close on conversation delete and on app exit (as `pty::close_all`).
4. **Chat view** — `ui/ia-chat.js` + CSS + i18n keys; history replay; streamed
   Markdown; tool rows; permission cards; Stop; status line. Browser harness
   test driving the view with the recorded fixture, both languages.
5. **Snap Studio additions** — version chips, preview thumbnails, image
   attachments, thinking rows, initial prompt as first message.
6. **Conversation | Terminal switch** — exclusive processes on one session;
   the hint banner reduced to the "previous conversation not found" case.
7. **Mode switch and polish** — permission mode control, model shown,
   keyboard (Enter / ⇧Enter / Esc / ⌘K focus), empty state, errors
   (`exited`, `error`, `api_retry` notes), docs and README.

## Out of scope for now

- Sub-agent transcripts nested under their tool row (`parent_tool_use_id`,
  `--forward-subagent-text`): later.
- Slash-command autocomplete in the composer.
- Several conversations streaming in parallel in the UI (the backend allows
  it; the UI shows one at a time).

## Licenses

- claude-chat-panel: MIT — keep its copyright notice in `chat.rs` and
  `ia-chat.js` headers ("adapted from…").
- marked: MIT; DOMPurify: Apache-2.0 or MPL-2.0 — license files next to them
  in `ui/vendor/`, like xterm.
- Avoid the AGPL projects (opcode, CloudCLI) as code sources.
