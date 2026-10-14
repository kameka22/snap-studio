"use strict";
/* AI tab: the conversation view.

   Claude Code runs in its structured mode (src-tauri/src/chat.rs): its events
   arrive as the "ia-chat" event, already slimmed; the past comes from the
   conversation's own log (workspace/chat.jsonl) or, for older conversations,
   from Claude's transcript. This view renders both the same way.

   Adapted from claude-chat-panel's page (web/chat.js,
   https://github.com/simscorpbs/claude-chat-panel, MIT License,
   Copyright (c) 2026 simscorpbs): streamed Markdown, tool rows, permission
   cards, Stop. */

const CHAT = {
  /* Conversation shown, or null. */
  id: null,
  /* Conversations whose turn is running, shown or not. */
  busy: new Set(),
  streaming: null,
  streamText: "",
  pending: false,
  /* tool_use id → row; request_id → permission card. */
  tools: new Map(),
  perms: new Map(),
  model: "",
  cost: 0,
  /* Images waiting to leave with the next message. */
  attach: [],
  /* Initial requests already sent, so a reopening does not send them twice. */
  autoSent: new Set(),
};

const CHAT_MAX_IMAGES = 5;
/* Longest side sent to Claude: beyond it, the model scales images down anyway. */
const CHAT_MAX_SIDE = 1568;
const INTERRUPTED = "[Request interrupted by user]";

const chatList = $("chat-list");

/* ------------------------------------------------------------ rendering */

marked.setOptions({ gfm: true, breaks: true });
/* Text can carry what third parties wrote (tool results, web pages):
   sanitized before it shows. */
const chatMd = (text) => DOMPurify.sanitize(marked.parse(text || ""));

const chatNearBottom = () => chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;

function chatAdd(el) {
  const stick = chatNearBottom();
  chatList.appendChild(el);
  if (stick) chatList.scrollTop = chatList.scrollHeight;
}

function chatDiv(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function chatClearEmpty() {
  chatList.querySelector(".chat-empty")?.remove();
}

function chatCopy(text, button) {
  navigator.clipboard?.writeText(text).catch(() => {});
  const before = button.textContent;
  button.textContent = tr("chat.copied");
  setTimeout(() => (button.textContent = before), 1200);
}

function chatCopyButton(cls, text) {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = tr("chat.copy");
  b.onclick = (e) => {
    e.stopPropagation();
    chatCopy(text(), b);
  };
  return b;
}

/* Copy buttons on code blocks. */
function chatDecorate(el) {
  el.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".chat-copy")) return;
    const code = pre.querySelector("code");
    pre.appendChild(chatCopyButton("chat-copy", () => (code || pre).innerText));
  });
}

function chatWorking() {
  const w = chatDiv("chat-working");
  w.setAttribute("aria-label", tr("chat.working"));
  w.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  return w;
}

/* The working dots always stay last. */
function chatMoveWorkingDown() {
  const w = chatList.querySelector(".chat-working");
  if (w) {
    w.remove();
    chatAdd(w);
  }
}

/* While a turn runs, Stop stands where Send was. */
function chatSetBusy(on) {
  if (CHAT.id) on ? CHAT.busy.add(CHAT.id) : CHAT.busy.delete(CHAT.id);
  $("chat-stop").classList.toggle("hidden", !on);
  $("chat-send").classList.toggle("hidden", on);
  chatList.querySelector(".chat-working")?.remove();
  if (on) chatAdd(chatWorking());
}

/* A conversation whose mode is not ready: its history only. */
function chatSetLocked(on) {
  for (const id of ["chat-input", "chat-send", "chat-add", "chat-mode"]) $(id).disabled = on;
  $("chat-input").placeholder = tr(on ? "chat.placeholder_locked" : "chat.placeholder");
}

function chatStatus() {
  const cost = CHAT.cost
    ? fmtNum(CHAT.cost, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "";
  $("chat-status").textContent = [CHAT.model, cost].filter(Boolean).join(" · ");
}

/* An image of the conversation folder, served by the thumbnail protocol. */
const chatAttachmentUrl = (name) =>
  `thumb://localhost/ia?ia=${encodeURIComponent(CHAT.id)}&att=${encodeURIComponent(name)}`;

/* A user message: images first, then the text. `images` are URLs. */
function chatUserBubble(text, images = []) {
  chatClearEmpty();
  const d = chatDiv("chat-msg user");
  if (images.length) {
    const row = chatDiv("chat-images");
    for (const src of images) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.onerror = () => img.remove();
      row.appendChild(img);
    }
    d.appendChild(row);
  }
  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    d.appendChild(span);
  }
  chatAdd(d);
  chatMoveWorkingDown();
}

function chatAssistant(text, el) {
  chatClearEmpty();
  const d = el || chatDiv("chat-msg assistant");
  d.classList.remove("streaming");
  d.innerHTML = chatMd(text);
  chatDecorate(d);
  d.appendChild(chatCopyButton("chat-copy-msg", () => text));
  if (!el) chatAdd(d);
  chatMoveWorkingDown();
}

/* One line saying what a tool works on: the command, the file, the pattern… */
function chatToolSummary(input) {
  if (!input) return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.url
    || input.query || input.skill || input.description || input.prompt || JSON.stringify(input);
  return String(v).split("\n")[0].slice(0, 160);
}

const chatToolName = (name) =>
  String(name || "").replace(/^mcp__claude_ai_/, "").replace(/^mcp__/, "").replace(/__/g, " · ");

function chatToolRow(id, name, input) {
  chatClearEmpty();
  const d = document.createElement("details");
  d.className = "chat-tool";
  const s = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "dot";
  const n = document.createElement("span");
  n.className = "name";
  n.textContent = chatToolName(name);
  const a = document.createElement("span");
  a.className = "arg";
  a.textContent = chatToolSummary(input);
  s.append(dot, n, a);
  d.appendChild(s);
  const body = document.createElement("pre");
  body.className = "result";
  d.appendChild(body);
  CHAT.tools.set(id, d);
  chatAdd(d);
  chatMoveWorkingDown();
}

function chatToolResult(id, content, isError) {
  const d = CHAT.tools.get(id);
  if (!d) return;
  const text = typeof content === "string"
    ? content
    : (content || []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  d.querySelector(".result").textContent = text;
  d.classList.add("done");
  if (isError) d.classList.add("error");
}

function chatNote(text, kind = "") {
  chatClearEmpty();
  chatAdd(chatDiv("chat-note " + kind, text));
  chatMoveWorkingDown();
}

/* Claude could not sign in: say so with a way out, and open the account
   window at once. The turn ends by itself (the backend interrupts it). */
function chatAuthFailed() {
  const engine = IA.list.find((x) => x.id === CHAT.id)?.engine || "local";
  const note = chatDiv("chat-note error", tr("chat.auth_failed"));
  const btn = document.createElement("button");
  btn.className = "btn small chat-note-btn";
  btn.textContent = tr("chat.auth_fix");
  btn.addEventListener("click", () => authOpen({ engine }));
  note.appendChild(btn);
  chatClearEmpty();
  chatAdd(note);
  chatMoveWorkingDown();
  authOpen({ engine });
}

/* A permission Claude asks for. `live`: answerable now. */
function chatPermission(ev, live) {
  const card = chatDiv("chat-card");
  card.dataset.request = ev.request_id;
  chatPermissionBody(card, ev, live);
  CHAT.perms.set(ev.request_id, card);
  chatAdd(card);
  chatMoveWorkingDown();
}

/* Fills a permission card; also used to make a replayed one answerable when
   Claude is still waiting for it. Two tools get a card of their own: a
   question Claude asks (AskUserQuestion) and the plan it proposes
   (ExitPlanMode). */
function chatPermissionBody(card, ev, live) {
  if (ev.request.tool_name === "AskUserQuestion") return chatQuestionBody(card, ev, live);
  if (ev.request.tool_name === "ExitPlanMode") return chatPlanBody(card, ev, live);
  chatClearEmpty();
  card._ev = ev;
  card.innerHTML = "";
  const r = ev.request;
  card.appendChild(chatDiv("title", tr("chat.permission", { tool: chatToolName(r.display_name || r.tool_name) })));
  const what = [r.description, chatToolSummary(r.input)].filter(Boolean);
  if (what[0] === what[1]) what.pop();
  card.appendChild(chatDiv("what", what.join("\n")));
  const row = chatDiv("row");
  const pill = (label, primary, allow, always) => {
    const b = document.createElement("button");
    b.className = "btn small" + (primary ? " primary" : "");
    b.textContent = label;
    b.onclick = async () => {
      row.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await invoke("ia_chat_answer", { id: CHAT.id, requestId: ev.request_id, allow, always });
        chatPermissionDone(ev.request_id, allow, always);
      } catch (e) {
        row.querySelectorAll("button").forEach((x) => (x.disabled = false));
        toast(String(e), true);
      }
    };
    row.appendChild(b);
  };
  if (live) {
    pill(tr("chat.allow"), true, true, false);
    if (r.can_always) pill(tr("chat.always"), false, true, true);
    pill(tr("chat.deny"), false, false, false);
  } else {
    row.appendChild(chatDiv("done", tr("chat.unanswered")));
  }
  card.appendChild(row);
}

/* Sends a permission answer; `input` carries a question's answers. */
async function chatAnswer(card, ev, allow, always, input) {
  card.querySelectorAll("button").forEach((x) => (x.disabled = true));
  try {
    await invoke("ia_chat_answer", { id: CHAT.id, requestId: ev.request_id, allow, always, input: input || null });
    chatPermissionDone(ev.request_id, allow, always, input?.answers);
  } catch (e) {
    card.querySelectorAll("button").forEach((x) => (x.disabled = false));
    toast(String(e), true);
  }
}

/* Claude's multiple-choice questions: one choice per question (several when
   it allows), then Send. */
function chatQuestionBody(card, ev, live) {
  chatClearEmpty();
  card._ev = ev;
  card.innerHTML = "";
  card.appendChild(chatDiv("title", tr("chat.question")));
  const questions = ev.request.input?.questions || [];
  const picked = questions.map(() => new Set());
  const row = chatDiv("row");
  const send = document.createElement("button");
  send.className = "btn small primary";
  send.textContent = tr("chat.answer");
  send.disabled = true;
  questions.forEach((q, qi) => {
    const box = chatDiv("chat-question");
    box.appendChild(chatDiv("q", q.question));
    const opts = chatDiv("opts");
    for (const o of q.options || []) {
      const b = document.createElement("button");
      b.className = "btn small opt";
      b.textContent = o.label;
      if (o.description) {
        const s = document.createElement("small");
        s.textContent = o.description;
        b.appendChild(s);
      }
      b.disabled = !live;
      b.onclick = () => {
        if (!q.multiSelect) {
          picked[qi].clear();
          opts.querySelectorAll(".opt").forEach((x) => x.classList.remove("on"));
        }
        picked[qi].has(o.label) ? picked[qi].delete(o.label) : picked[qi].add(o.label);
        b.classList.toggle("on", picked[qi].has(o.label));
        send.disabled = picked.some((p) => !p.size);
      };
      opts.appendChild(b);
    }
    box.appendChild(opts);
    card.appendChild(box);
  });
  if (live) {
    send.onclick = () => {
      const answers = {};
      questions.forEach((q, i) => (answers[q.question] = [...picked[i]].join(", ")));
      chatAnswer(card, ev, true, false, { ...ev.request.input, answers });
    };
    row.appendChild(send);
    const skip = document.createElement("button");
    skip.className = "btn small";
    skip.textContent = tr("chat.skip_question");
    skip.onclick = () => chatAnswer(card, ev, false, false);
    row.appendChild(skip);
  } else {
    row.appendChild(chatDiv("done", tr("chat.unanswered")));
  }
  card.appendChild(row);
}

/* The plan Claude proposes in plan mode: approve it, or keep planning. */
function chatPlanBody(card, ev, live) {
  chatClearEmpty();
  card._ev = ev;
  card.innerHTML = "";
  card.appendChild(chatDiv("title", tr("chat.plan")));
  const plan = chatDiv("chat-plan chat-msg assistant");
  plan.innerHTML = chatMd(ev.request.input?.plan || "");
  card.appendChild(plan);
  const row = chatDiv("row");
  if (live) {
    const ok = document.createElement("button");
    ok.className = "btn small primary";
    ok.textContent = tr("chat.plan_approve");
    ok.onclick = () => chatAnswer(card, ev, true, false);
    const no = document.createElement("button");
    no.className = "btn small";
    no.textContent = tr("chat.plan_keep");
    no.onclick = () => chatAnswer(card, ev, false, false);
    row.append(ok, no);
  } else {
    row.appendChild(chatDiv("done", tr("chat.unanswered")));
  }
  card.appendChild(row);
}

function chatPermissionDone(requestId, allow, always, answers) {
  const card = CHAT.perms.get(requestId);
  if (!card) return;
  card.dataset.answered = "1";
  if (answers && typeof answers === "object") {
    const row = card.querySelector(".row");
    row.innerHTML = "";
    row.appendChild(chatDiv("done", tr("chat.answered", { a: Object.values(answers).join(" · ") })));
    card.querySelectorAll(".opt").forEach((b) => (b.disabled = true));
    return;
  }
  if (card._ev?.request?.tool_name === "ExitPlanMode") {
    const row = card.querySelector(".row");
    row.innerHTML = "";
    row.appendChild(chatDiv("done", tr(allow ? "chat.plan_approved" : "chat.plan_kept")));
    return;
  }
  const row = card.querySelector(".row");
  row.innerHTML = "";
  row.appendChild(chatDiv("done", tr(allow ? (always ? "chat.allowed_always" : "chat.allowed") : "chat.denied")));
}

/* A preview Claude looked at, as it was then: shown on its tool row, so the
   user sees what Claude saw. */
function chatSeen(toolId, name) {
  const row = CHAT.tools.get(toolId);
  if (!row) return;
  const img = document.createElement("img");
  img.className = "chat-seen";
  img.src = chatAttachmentUrl(name);
  img.alt = "";
  img.onerror = () => img.remove();
  row.after(img);
}

/* A new version of the object, archived while Claude worked. */
function chatVersion(n) {
  chatClearEmpty();
  const chip = document.createElement("button");
  chip.className = "chat-version";
  chip.dataset.v = n;
  chip.textContent = tr("chat.version", { n });
  chip.title = tr("ia.version.revert");
  chatAdd(chip);
  chatMoveWorkingDown();
}

/* ------------------------------------------------------------ events */

/* `live`: the event just happened; otherwise it is replayed from the past. */
function chatHandle(ev, live) {
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") {
        CHAT.model = ev.model || CHAT.model;
        chatStatus();
        if (ev.mode) chatModeShow(ev.mode);
      } else if (ev.subtype === "mode") {
        chatModeShow(ev.mode);
      } else if (ev.subtype === "api_retry" && live && ev.error !== "authentication_failed") {
        chatNote(tr("chat.retry", { n: ev.attempt, max: ev.max_retries }), "muted");
      }
      break;
    case "stream_event": {
      const e = ev.event || {};
      if (e.type === "message_start") {
        CHAT.streaming = null;
        CHAT.streamText = "";
      }
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        CHAT.streamText += e.delta.text;
        if (!CHAT.streaming) {
          chatClearEmpty();
          CHAT.streaming = chatDiv("chat-msg assistant streaming");
          chatAdd(CHAT.streaming);
          chatMoveWorkingDown();
        }
        if (!CHAT.pending) {
          CHAT.pending = true;
          requestAnimationFrame(() => {
            CHAT.pending = false;
            if (!CHAT.streaming) return;
            const stick = chatNearBottom();
            CHAT.streaming.innerHTML = chatMd(CHAT.streamText);
            if (stick) chatList.scrollTop = chatList.scrollHeight;
          });
        }
      }
      break;
    }
    case "assistant":
      for (const block of ev.message?.content || []) {
        if (block.type === "text" && block.text) {
          chatAssistant(block.text, CHAT.streaming);
          CHAT.streaming = null;
          CHAT.streamText = "";
        } else if (block.type === "tool_use") {
          chatToolRow(block.id, block.name, block.input);
        }
      }
      break;
    case "user": {
      const content = ev.message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
      const images = [];
      let text = "";
      for (const block of blocks) {
        if (block.type === "tool_result") chatToolResult(block.tool_use_id, block.content, block.is_error);
        else if (block.type === "attachment") images.push(chatAttachmentUrl(block.name));
        else if (block.type === "text" && block.text.trim() && block.text !== INTERRUPTED) text += block.text;
      }
      if (text || images.length) chatUserBubble(text, images);
      break;
    }
    case "control_request":
      if (ev.request?.subtype === "can_use_tool") chatPermission(ev, live);
      break;
    case "permission_answer":
      chatPermissionDone(ev.request_id, ev.allow, ev.always, ev.answers);
      break;
    case "version":
      chatVersion(ev.n);
      break;
    case "seen":
      chatSeen(ev.tool_use_id, ev.name);
      break;
    case "result":
      if (typeof ev.total_cost_usd === "number") {
        CHAT.cost = ev.total_cost_usd;
        chatStatus();
      }
      if (CHAT.streaming && CHAT.streamText) chatAssistant(CHAT.streamText, CHAT.streaming);
      CHAT.streaming = null;
      CHAT.streamText = "";
      if (live) chatSetBusy(false);
      if (ev.is_error && ev.subtype === "error_during_execution") chatNote(tr("chat.stopped"), "muted");
      else if (ev.is_error && ev.result) chatNote(String(ev.result), "error");
      break;
    case "exited":
      if (CHAT.busy.has(CHAT.id)) chatNote(tr("chat.exited"), "muted");
      chatSetBusy(false);
      break;
    case "auth_failed":
      if (live) chatAuthFailed();
      break;
    case "error":
      chatSetBusy(false);
      chatNote(ev.text, "error");
      break;
  }
}

listen("ia-chat", (e) => {
  const { id, events } = e.payload;
  for (const ev of events) {
    if (id === CHAT.id) chatHandle(ev, true);
    else if (ev.type === "result" || ev.type === "exited") CHAT.busy.delete(id);
  }
});

/* A version archived while the conversation is shown: its chip, live. The
   log keeps it for the next opening. */
listen("ia-mesh", (e) => {
  if (e.payload.id === CHAT.id) chatVersion(e.payload.version);
});

/* ------------------------------------------------------------ mode */

/* Modes offered: locally, from the most autonomous to plan only; in the
   sandbox, everything is allowed already, so only plan mode is a choice. */
const CHAT_MODES = {
  local: ["acceptEdits", "default", "plan"],
  container: ["bypassPermissions", "plan"],
};

function chatModeFill(c) {
  const sel = $("chat-mode");
  const modes = CHAT_MODES[c.engine === "container" ? "container" : "local"];
  sel.innerHTML = modes.map((m) => `<option value="${m}">${esc(tr("chat.mode." + m))}</option>`).join("");
  sel.value = modes[0];
}

/* The mode Claude reports — after our change, or when it leaves plan mode. */
function chatModeShow(mode) {
  const sel = $("chat-mode");
  if ([...sel.options].some((o) => o.value === mode)) sel.value = mode;
}

$("chat-mode").addEventListener("change", (e) => {
  if (CHAT.id) invoke("ia_chat_mode", { id: CHAT.id, mode: e.target.value }).catch((err) => toast(String(err), true));
});

/* ------------------------------------------------------------ opening */

function chatReset() {
  chatList.innerHTML = "";
  CHAT.tools.clear();
  CHAT.perms.clear();
  CHAT.streaming = null;
  CHAT.streamText = "";
  CHAT.model = "";
  CHAT.cost = 0;
  chatStatus();
}

/* Shows a conversation: its past, then — for a brand new one — its initial
   request as the first message. */
async function chatOpen(c) {
  CHAT.id = c.id;
  chatReset();
  chatClearAttachments();
  chatModeFill(c);
  let past = [];
  try {
    past = (await invoke("ia_chat_history", { id: c.id })) || [];
  } catch {}
  if (CHAT.id !== c.id) return;
  for (const ev of past) chatHandle(ev, false);
  chatList.scrollTop = chatList.scrollHeight;
  const busy = CHAT.busy.has(c.id);
  CHAT.busy.delete(c.id);
  chatSetBusy(busy);
  // Claude may still be waiting on a permission asked while the conversation
  // was not shown: its card becomes answerable again.
  const waiting = [...CHAT.perms.values()].filter((card) => !card.dataset.answered);
  if (waiting.length && (await invoke("ia_chat_running", { id: c.id }).catch(() => false)) && CHAT.id === c.id) {
    for (const card of waiting) chatPermissionBody(card, card._ev, true);
  }
  chatSetLocked(!!IA.locked);
  if (!past.length) {
    chatList.appendChild(chatDiv("chat-empty", tr(iaIsCreation(c) ? "chat.empty_create" : "chat.empty")));
    if (c.prompt && !c.started && !CHAT.autoSent.has(c.id) && !IA.locked) {
      CHAT.autoSent.add(c.id);
      chatSend(c.prompt, []);
    }
  }
  $("chat-input").focus();
}

function chatLeave() {
  CHAT.id = null;
  chatClearAttachments();
}

/* ------------------------------------------------------------ sending */

async function chatSend(text, attachments) {
  const id = CHAT.id;
  if (!id || (!text && !attachments.length)) return;
  const c = IA.list.find((x) => x.id === id);
  chatUserBubble(text, attachments.map((a) => a.url));
  chatList.scrollTop = chatList.scrollHeight;
  chatSetBusy(true);
  // The first start of the sandbox builds its image: say so, it takes a while.
  if (c?.engine === "container" && !(await invoke("ia_chat_running", { id }).catch(() => true))) {
    if (CHAT.id === id) chatNote(tr("ia.sandbox_starting"), "muted");
  }
  try {
    await invoke("ia_chat_send", {
      id,
      text,
      images: attachments.map(({ name, media_type, data }) => ({ name, media_type, data })),
    });
    if (c) c.started = true;
  } catch (e) {
    if (CHAT.id === id) {
      chatSetBusy(false);
      chatNote(String(e), "error");
    } else {
      CHAT.busy.delete(id);
    }
  }
}

function chatSubmit() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text && !CHAT.attach.length) return;
  const attachments = CHAT.attach;
  CHAT.attach = [];
  chatRenderAttachments();
  input.value = "";
  chatGrow();
  chatSend(text, attachments);
}

function chatGrow() {
  const input = $("chat-input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
  $("chat-send").disabled = !input.value.trim() && !CHAT.attach.length;
}

/* ------------------------------------------------------------ attachments */

/* Reads an image and scales it so its longest side fits CHAT_MAX_SIDE. A
   PNG small enough stays a PNG (sketches keep their crisp lines); anything
   else becomes a JPEG. */
function chatReadImage(file) {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, CHAT_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const keep = scale === 1 && file.type === "image/png" && file.size < 3_500_000;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      if (!keep) ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const type = keep ? "image/png" : "image/jpeg";
      const dataUrl = canvas.toDataURL(type, 0.9);
      const base = (file.name || "image").replace(/\.[^.]+$/, "");
      ok({
        name: base + (keep ? ".png" : ".jpg"),
        media_type: type,
        data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        url: dataUrl,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      ko(new Error(tr("chat.bad_image", { name: file.name || "?" })));
    };
    img.src = url;
  });
}

async function chatAddFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    if (CHAT.attach.length >= CHAT_MAX_IMAGES) {
      toast(tr("chat.too_many", { n: CHAT_MAX_IMAGES }), true);
      break;
    }
    try {
      CHAT.attach.push(await chatReadImage(f));
    } catch (e) {
      toast(e.message, true);
    }
  }
  chatRenderAttachments();
}

function chatRenderAttachments() {
  const box = $("chat-attach");
  box.innerHTML = "";
  CHAT.attach.forEach((a, i) => {
    const t = chatDiv("chat-thumb");
    const img = document.createElement("img");
    img.src = a.url;
    img.alt = a.name;
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = tr("common.delete");
    x.onclick = () => {
      CHAT.attach.splice(i, 1);
      chatRenderAttachments();
    };
    t.append(img, x);
    box.appendChild(t);
  });
  box.classList.toggle("hidden", !CHAT.attach.length);
  chatGrow();
}

function chatClearAttachments() {
  CHAT.attach = [];
  chatRenderAttachments();
}

/* ------------------------------------------------------------ controls */

$("chat-input").addEventListener("input", chatGrow);
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!CHAT.busy.has(CHAT.id)) chatSubmit();
  } else if (e.key === "Escape" && CHAT.busy.has(CHAT.id)) {
    e.preventDefault();
    invoke("ia_chat_stop", { id: CHAT.id }).catch(() => {});
  }
});
$("chat-input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    chatAddFiles(files);
  }
});
$("chat-send").addEventListener("click", chatSubmit);
$("chat-stop").addEventListener("click", () => invoke("ia_chat_stop", { id: CHAT.id }).catch(() => {}));
$("chat-add").addEventListener("click", () => $("chat-file").click());
$("chat-file").addEventListener("change", (e) => {
  chatAddFiles([...e.target.files]);
  e.target.value = "";
});
$("ia-chat").addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith("image/"))) e.preventDefault();
});
$("ia-chat").addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    chatAddFiles(files);
  }
});

/* Links open in the browser, never in the app's window. */
chatList.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a?.href) {
    e.preventDefault();
    invoke("plugin:opener|open_url", { url: a.href }).catch((err) => toast(String(err), true));
    return;
  }
  const v = e.target.closest(".chat-version");
  if (v && CHAT.id) iaShowVersion(CHAT.id, +v.dataset.v);
});

/* A new language: the conversation is drawn again from its past. */
window.addEventListener("langchange", () => {
  const c = CHAT.id && IA.list.find((x) => x.id === CHAT.id);
  if (c && !CHAT.busy.has(c.id)) chatOpen(c);
});
