"use strict";
/* AI tab: one conversation per object — to modify, or to create from scratch.

   Each conversation owns a working folder, prepared by Rust: the object as
   a 3MF of colored parts, the instructions, the tools and the export skill.
   The detail screen holds the conversation and the 3D pane. */

const IA = {
  list: [],
  engine: null,
  /* The file picked in Files, while the sheet is open; null when creating
     an object from scratch. */
  source: null,
  /* "edit" from Files, "create" from the ＋ button. */
  mode: "edit",
  /* Conversation open on screen, or null on the list. */
  open: null,
  /* How the open conversation shows: "chat" (ia-chat.js) or "term", the raw
     Claude Code terminal on the same session. */
  view: localStorage.getItem("snapstudio.iaview") === "term" ? "term" : "chat",
  /* One emulator per conversation: leaving the tab must not erase anything.
     id -> { term, fit, el, dead } */
  terms: new Map(),
};

/* ------------------------------------------------------------ loading */

async function iaRefresh() {
  try {
    IA.list = await invoke("ia_list");
  } catch (e) {
    IA.list = [];
  }
  iaRender();
  // The sandbox state changes without notice — Docker starts and stops —
  // and querying it takes a moment: refresh on the side.
  invoke("ia_engine")
    .then((e) => {
      IA.engine = e;
      if (!IA.open) iaRender();
    })
    .catch(() => {});
}

/* The sandbox is only usable when the daemon answers: Docker installed but
   stopped is the most common case on macOS. */
const iaSandboxReady = () => {
  const e = IA.engine || {};
  return !!(e.docker && e.daemon && e.yolobox);
};

function iaDefaultEngine() {
  return iaSandboxReady() ? "container" : "local";
}

function iaEngineLabel() {
  const e = IA.engine || {};
  if (!e.claude) return tr("ia.engine.no_claude");
  if (iaSandboxReady()) return tr("ia.engine.container_ok");
  if (e.docker && e.yolobox && !e.daemon) return tr("ia.engine.docker_stopped");
  return tr("ia.engine.local_mode");
}

/* Why the container is not offered, in plain words. */
function iaSandboxReason() {
  const e = IA.engine || {};
  if (iaSandboxReady()) return tr("ia.engine.container");
  if (!e.docker) return tr("ia.engine.no_docker");
  if (!e.daemon) return tr("ia.engine.daemon_off");
  return tr("ia.engine.no_yolobox");
}

/* ------------------------------------------------------------ display */

const iaIsCreation = (c) => c.kind === "create";
/* A created object Claude has not exported a first time yet. */
const iaEmpty = (c) => !!c && iaIsCreation(c) && !c.version;

/* The original object's thumbnail, served by the thumbnail protocol. A
   created object has none: show the preview the app renders for Claude, the
   version busting the cache. */
const iaThumb = (c) =>
  iaIsCreation(c)
    ? `thumb://localhost/ia?ia=${encodeURIComponent(c.id)}&v=${c.version}`
    : `thumb://localhost/t?p=${encodeURIComponent(c.source)}&s=176&k=0&v=${c.created_at}`;

/* "from support.3mf", or "new design · My models" for a new object. */
function iaOrigin(c) {
  if (!iaIsCreation(c)) return tr("ia.from", { name: c.source_name });
  return c.dest_dir ? `${tr("ia.creation")} · ${baseName(c.dest_dir)}` : tr("ia.creation");
}

const iaEngineName = (c) => tr(c.engine === "container" ? "ia.engine.container_short" : "ia.engine.local_short");

/* Missing or unreadable source: keep the tile, empty. A transparent pixel
   avoids the renderer's broken-image icon. */
const IA_BLANK =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function iaNoThumb(img) {
  img.onerror = null;
  img.src = IA_BLANK;
}

function iaStatus(c) {
  if (c.saved) return `<span class="ia-badge done">✓ ${esc(tr("ia.saved_badge"))}</span>`;
  return `<span class="ia-badge">○ ${esc(tr("ia.pending_badge"))}</span>`;
}

/* Conversations under the sidebar's AI entry, like recent folders under
   Files; the open conversation is selected there. */
const IA_GLYPH = '<svg viewBox="0 0 24 24"><path d="M12 2.5 14 8l5.5 2-5.5 2-2 5.5L10 12 4.5 10 10 8zm6.5 10 1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/></svg>';
function iaRenderSide() {
  const box = $("side-ia");
  box.innerHTML = "";
  for (const c of IA.list) {
    const b = document.createElement("button");
    b.className = "side-item";
    b.dataset.conv = c.id;
    b.title = iaOrigin(c);
    b.innerHTML = `<span class="glyph" style="color: #AF52DE">${IA_GLYPH}</span><span class="lbl">${esc(c.title)}</span>`;
    b.onclick = () => {
      switchView("ia");
      if (IA.open !== c.id) iaOpen(c.id);
    };
    b.oncontextmenu = (e) =>
      nativeMenu([
        { id: "ia:open:" + c.id, label: tr("ia.open_conv") },
        { id: "ia:folder:" + c.id, label: tr("ia.show_workspace") },
        {},
        { id: "ia:delete:" + c.id, label: tr("common.delete") },
      ], e.clientX, e.clientY);
    box.appendChild(b);
  }
  sideSync();
}

function iaRender() {
  iaRenderSide();
  const detail = !!IA.open;
  $("ia-engine-tag").classList.toggle("hidden", detail);
  $("ia-new").classList.toggle("hidden", detail);
  $("ia-dacts").classList.toggle("hidden", !detail);
  $("ia-back").classList.toggle("hidden", !detail);
  if (!detail) $("ia-engine-tag").textContent = iaEngineLabel();
  sideCount("ia", IA.list.length);
  const c = detail && IA.list.find((x) => x.id === IA.open);
  if (c) tbSet("ia", c.title, `${iaOrigin(c)} · ${iaEngineName(c)}`);
  else tbSet("ia", tr("nav.ia"), IA.list.length ? tr("ia.count", { n: IA.list.length }) : "");
  $("ia-detail").classList.toggle("hidden", !detail);
  $("ia-empty").classList.toggle("hidden", detail || IA.list.length > 0);
  $("ia-list").classList.toggle("hidden", detail || IA.list.length === 0);
  if (detail) return;

  $("ia-list").innerHTML = IA.list
    .map((c) => {
      // A created object has nothing to show before Claude's first export.
      const thumb = c.version
        ? `<img class="ia-thumb" src="${esc(iaThumb(c))}" alt="" onerror="iaNoThumb(this)" />`
        : `<div class="ia-thumb blank">${IA_GLYPH}</div>`;
      return `<article class="ia-card" data-id="${esc(c.id)}">
        ${thumb}
        <div class="ia-body">
          <h3>${esc(c.title)}</h3>
          <div class="ia-sub">${esc(iaOrigin(c))}</div>
          <div class="ia-meta">${esc(fmtAgo(c.updated_at))} · ${c.version ? `v${c.version}` : esc(tr("ia.draft"))} · ${esc(
            iaEngineName(c)
          )}</div>
          ${iaStatus(c)}
        </div>
        <button class="ia-del" data-act="ask" data-id="${esc(c.id)}" title="${esc(tr("common.delete"))}">✕</button>
      </article>`;
    })
    .join("");
}

/* ------------------------------------------------------------ creation */

/* The sheet serves both paths: only the labels and the creation fields
   change. */
function iaSheet(mode) {
  IA.mode = mode;
  const create = mode === "create";
  $("ia-mtitle").textContent = tr(create ? "ia.new_object" : "ia.new.title");
  $("ia-plabel").textContent = tr(create ? "ia.new.describe" : "ia.new.what");
  $("ia-prompt").placeholder = tr(create ? "ia.new.placeholder_create" : "ia.new.placeholder_edit");
  $("ia-hints").textContent = tr(create ? "ia.new.hints_create" : "ia.new.hints_edit");
  $("ia-cfields").classList.toggle("hidden", !create);
  $("ia-prompt").value = "";
  $("ia-msg").textContent = "";
  $("ia-msg").className = "pf-test";

  const sel = $("ia-engine");
  sel.options[0].disabled = !iaSandboxReady();
  sel.options[0].textContent = iaSandboxReason();
  sel.value = iaDefaultEngine();

  openSheet($("iamodal"));
  $("ia-prompt").focus();
}

/* Called from the Files screen. */
function iaStart(file) {
  if (!file || file.kind === "gcode") return;
  IA.source = file;
  $("ia-src").textContent = file.name;
  iaSheet("edit");
}

/* Folders offered to store the object: the one Files shows, then the
   recent ones, and a way to pick another. */
function iaFillDest(pick) {
  const dirs = [...new Set([pick, state.dir, ...(state.recents || [])].filter(Boolean))];
  $("ia-dest").innerHTML =
    dirs.map((d) => `<option value="${esc(d)}" title="${esc(d)}">${esc(baseName(d))}</option>`).join("") +
    `<option value="">${esc(tr("ia.new.other_folder"))}</option>`;
  $("ia-dest").value = dirs[0] || "";
  $("ia-dest").dataset.prev = dirs[0] || "";
}

$("ia-dest").addEventListener("change", async () => {
  const sel = $("ia-dest");
  if (sel.value) {
    sel.dataset.prev = sel.value;
    return;
  }
  const dir = await invoke("pick_folder");
  if (dir) iaFillDest(dir);
  else sel.value = sel.dataset.prev;
});

/* Creation from scratch: the size limit starts from the printer's bed. */
function iaNew() {
  IA.source = null;
  $("ia-src").textContent = "";
  const bed = (typeof PR !== "undefined" && PR.bed) || { w: 270, d: 270 };
  $("ia-bx").value = bed.w;
  $("ia-by").value = bed.d;
  $("ia-bz").value = 270;
  iaFillDest();
  iaSheet("create");
}

/* The size entered, or null when incomplete: then nothing is imposed. */
function iaBounds() {
  const v = ["ia-bx", "ia-by", "ia-bz"].map((k) => parseFloat($(k).value));
  return v.every((x) => x > 0) ? v : null;
}

async function iaCreate() {
  const create = IA.mode === "create";
  if (!create && !IA.source) return;
  if (create && !$("ia-prompt").value.trim()) {
    $("ia-msg").textContent = tr("ia.new.need_prompt");
    $("ia-msg").className = "pf-test err";
    $("ia-prompt").focus();
    return;
  }
  if (create && !$("ia-dest").value) {
    $("ia-msg").textContent = tr("ia.new.need_dest");
    $("ia-msg").className = "pf-test err";
    return;
  }
  const btn = $("ia-go");
  btn.disabled = true;
  $("ia-msg").textContent = tr("ia.new.preparing");
  $("ia-msg").className = "pf-test busy";
  try {
    const c = create
      ? await invoke("ia_create_blank", {
          prompt: $("ia-prompt").value,
          engine: $("ia-engine").value,
          dest: $("ia-dest").value,
          bounds: iaBounds(),
        })
      : await invoke("ia_create", {
          source: IA.source.path,
          prompt: $("ia-prompt").value,
          engine: $("ia-engine").value,
        });
    closeSheet($("iamodal"));
    await iaRefresh();
    switchView("ia");
    toast(tr("ia.created"));
    iaOpen(c.id);
  } catch (e) {
    $("ia-msg").textContent = String(e);
    $("ia-msg").className = "pf-test err";
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ actions */

async function iaAskDelete(id) {
  const c = IA.list.find((x) => x.id === id);
  if (!c) return;
  if (await confirmDelete(tr("printers.remove.title", { name: c.title }), tr("ia.delete.text"))) iaDelete(id);
}

async function iaDelete(id) {
  try {
    IA.list = await invoke("ia_delete", { id });
    // The terminal was closed on the app side: its emulator has no purpose left.
    const t = IA.terms.get(id);
    if (t) {
      t.term.dispose();
      IA.terms.delete(id);
    }
    if (IA.open === id) iaBack();
    iaRender();
    toast(tr("ia.deleted"));
  } catch (e) {
    toast(String(e), true);
  }
}

/* ------------------------------------------------------------ events */

$("ia-list").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (btn) {
    ev.stopPropagation();
    if (btn.dataset.act === "ask") iaAskDelete(btn.dataset.id);
    return;
  }
  const card = ev.target.closest(".ia-card");
  if (!card) return;
  const c = IA.list.find((x) => x.id === card.dataset.id);
  if (c) iaOpen(c.id);
});

$("ia-list").addEventListener("contextmenu", (ev) => {
  const card = ev.target.closest(".ia-card");
  if (!card) return;
  nativeMenu([
    { id: "ia:open:" + card.dataset.id, label: tr("ia.open_conv") },
    { id: "ia:folder:" + card.dataset.id, label: tr("ia.show_workspace") },
    {},
    { id: "ia:delete:" + card.dataset.id, label: tr("common.delete") },
  ], ev.clientX, ev.clientY);
});
onMenu("ia", async (arg) => {
  const i = arg.indexOf(":");
  const what = arg.slice(0, i), id = arg.slice(i + 1);
  if (what === "open") iaOpen(id);
  if (what === "delete") iaAskDelete(id);
  if (what === "folder") {
    const path = await invoke("ia_workspace", { id });
    invoke("reveal", { path }).catch((e) => toast(String(e), true));
  }
});

$("act-ia").addEventListener("click", () => {
  const path = [...state.sel][0];
  iaStart(state.files.find((f) => f.path === path));
});

$("ia-go").addEventListener("click", iaCreate);
$("ia-new").addEventListener("click", iaNew);
$("ia-empty-new").addEventListener("click", iaNew);
$("ia-empty-files").addEventListener("click", () => switchView("files"));
$("ia-cancel").addEventListener("click", () => closeSheet($("iamodal")));

document.addEventListener("keydown", (e) => {
  if ($("iamodal").classList.contains("hidden")) return;
  if (e.key === "Escape") closeSheet($("iamodal"));
  // ⌘⏎ confirms; plain Enter makes a new line in the text area.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); // otherwise ⌘⏎ also goes to "Add to Slicer Plate"
    iaCreate();
  }
});

/* ------------------------------------------------------------ terminal */

/* One emulator per conversation, kept in memory while the app lives.
   Switching tabs or going back to the list must not erase anything: the
   element is detached, not destroyed. */

/* Terminal colors matched to the tokens: --content-bg background, --text
   text, cursor in the system accent color. */
function iaTheme() {
  // --accent may be the AccentColor keyword: read the resolved color.
  const probe = document.createElement("i");
  probe.style.color = "var(--accent)";
  document.body.appendChild(probe);
  const accent = getComputedStyle(probe).color || "#007aff";
  probe.remove();
  return isDark()
    ? { background: "#1e1e20", foreground: "#f5f5f7", cursor: accent, selectionBackground: "#3f4a5c" }
    : { background: "#f3f3f5", foreground: "#1d1d1f", cursor: accent, selectionBackground: "#b3d7ff" };
}

function iaTerm(id) {
  let t = IA.terms.get(id);
  if (t) return t;
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: iaTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "ia-term-host";
  term.onData((d) => invoke("pty_write", { id, data: d }).catch(() => {}));
  t = { term, fit, el, opened: false, dead: false };
  IA.terms.set(id, t);
  return t;
}

window.addEventListener("themechange", () => {
  for (const t of IA.terms.values()) t.term.options.theme = iaTheme();
});

/* Fitting depends on the real on-screen size: the element must be visible,
   so after display. */
function iaFit(id) {
  const t = IA.terms.get(id);
  if (!t || !t.opened) return;
  try {
    t.fit.fit();
    invoke("pty_resize", { id, cols: t.term.cols, rows: t.term.rows }).catch(() => {});
  } catch {}
}

/* Say ahead what is going to happen, rather than leave the user facing an
   unexpected question or a thread that does not come back. */
async function iaHint(c) {
  const el = $("ia-hint");
  if (!c.started) {
    // Only the terminal asks whether to trust the folder; the chat never does.
    if (IA.view === "term") {
      el.innerHTML = tr("ia.hint.first");
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
    return;
  }
  let resumable = true;
  try {
    resumable = await invoke("ia_resumable", { id: c.id });
  } catch {}
  if (resumable) {
    el.classList.add("hidden");
    return;
  }
  el.innerHTML = tr("ia.hint.lost");
  el.classList.remove("hidden");
}

async function iaOpen(id) {
  const c = IA.list.find((x) => x.id === id);
  if (!c) return;
  IA.open = id;
  iaRender();
  $("ia-left").dataset.mode = IA.view;
  document.querySelectorAll("#ia-views [data-iaview]").forEach((b) => b.classList.toggle("on", b.dataset.iaview === IA.view));
  iaHint(c);
  // The 3D pane and the folder watch live with the screen.
  iaQueue(() => iaLoadPane(id));
  if (IA.view === "chat") chatOpen(c);
  else iaOpenTerminal(c);
}

/* The raw Claude Code terminal of the conversation. */
function iaOpenTerminal(c) {
  const id = c.id;
  const host = $("ia-term");
  const t = iaTerm(id);
  host.innerHTML = "";
  host.appendChild(t.el);
  if (!t.opened) {
    t.term.open(t.el);
    t.opened = true;
  }
  $("ia-dead").classList.toggle("hidden", !t.dead);

  // Wait one frame: xterm measures the cell on the displayed element.
  requestAnimationFrame(async () => {
    iaFit(id);
    if (!t.dead) {
      if (c.engine === "container" && !t.greeted) {
        t.greeted = true;
        t.term.writeln(`\x1b[90m${tr("ia.sandbox_starting")}\x1b[0m`);
      }
      try {
        await invoke("pty_open", { id, cols: t.term.cols, rows: t.term.rows });
      } catch (e) {
        t.term.writeln(`\x1b[31m${String(e)}\x1b[0m`);
        t.dead = true;
        $("ia-dead").classList.remove("hidden");
      }
    }
    t.term.focus();
  });
}

/* The viewer is unique: it must leave the pane as soon as the tab changes,
   otherwise files opened elsewhere would show in a hidden view — and come
   back to haunt the conversation. */
function iaSetVisible(on) {
  if (!IA.open) return;
  if (on) {
    if (!iaEmpty(IA.list.find((x) => x.id === IA.open))) iaDock();
    iaLoadPane(IA.open);
  } else {
    iaUndock();
  }
}

function iaBack() {
  iaUndock();
  IA.open = null;
  chatLeave();
  // The element goes back in reserve: the terminal history is kept.
  const host = $("ia-term");
  if (host.firstChild) host.removeChild(host.firstChild);
  iaRefresh();
}

async function iaRestart() {
  const id = IA.open;
  const t = IA.terms.get(id);
  if (!t) return;
  t.dead = false;
  $("ia-dead").classList.add("hidden");
  t.term.writeln("");
  try {
    await invoke("pty_open", { id, cols: t.term.cols, rows: t.term.rows });
  } catch (e) {
    toast(String(e), true);
    t.dead = true;
    $("ia-dead").classList.remove("hidden");
  }
}

/* Bytes arrive in base64: hand them as is to the emulator, which can glue
   back a character split across two packets. */
listen("ia-pty", (e) => {
  const t = IA.terms.get(e.payload.id);
  if (!t) return;
  const bin = atob(e.payload.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  t.term.write(bytes);
});

listen("ia-exit", (e) => {
  const t = IA.terms.get(e.payload.id);
  if (!t) return;
  t.dead = true;
  if (IA.open === e.payload.id) $("ia-dead").classList.remove("hidden");
});

/* ------------------------------------------------------------ detail */

$("ia-back").addEventListener("click", iaBack);
$("ia-restart").addEventListener("click", iaRestart);

$("ia-stop").addEventListener("click", async () => {
  if (!IA.open) return;
  await Promise.all([invoke("pty_close", { id: IA.open }), invoke("ia_chat_close", { id: IA.open })]);
});

$("ia-folder").addEventListener("click", async () => {
  if (!IA.open) return;
  const path = await invoke("ia_workspace", { id: IA.open });
  invoke("reveal", { path }).catch((e) => toast(String(e), true));
});

const iaResizeObserver = new ResizeObserver(() => {
  if (IA.open) iaFit(IA.open);
});
iaResizeObserver.observe($("ia-term"));

/* ------------------------------------------------------------ 3D pane */

/* The viewer is not duplicated: the app's own is moved into the pane. Same
   graphics context, same code, no possible divergence. */

function iaDock() {
  const v = $("viewer");
  if (v.parentElement !== $("ia-stage")) {
    $("ia-stage").appendChild(v);
    v.classList.add("docked");
  }
  v.classList.remove("hidden");
}

function iaUndock(hide = true) {
  const v = $("viewer");
  v.classList.remove("docked");
  if (hide) {
    v.classList.add("hidden");
    V.onClose = null;
  }
  if (v.parentElement !== document.body) document.body.appendChild(v);
}

/* The pane is narrow: the part must be examinable full size, as from the
   Files screen. The viewer leaves its frame without reloading anything, and
   Close — or Esc — puts it back. */
function iaExpand() {
  if (!IA.open || $("viewer").classList.contains("hidden")) return;
  iaUndock(false);
  if (typeof draw === "function") draw();
  V.onClose = () => {
    iaDock();
    if (typeof draw === "function") draw();
  };
}

/* Estimated mass: PLA weighs 1.24 g per cubic centimeter. Without a closed
   mesh the volume means nothing, so we abstain. */
function iaRenderStats(s) {
  IA.stats = s;
  const rows = [[tr("ia.stats.size"), s.size.map((x) => fmtDec(x, 1)).join(" × ") + " mm"]];
  if (s.watertight === true) {
    rows.push([tr("ia.stats.mass"), tr("ia.stats.mass_v", { g: Math.round(s.volume_cm3 * 1.24) })]);
  }
  const leak = s.watertight === false;
  rows.push([
    tr("ia.stats.watertight"),
    tr(s.watertight === null ? "ia.stats.unchecked" : s.watertight ? "common.yes" : "common.no"),
    leak,
  ]);
  rows.push([tr("ia.stats.faces"), fmtNum(s.triangles)]);
  $("ia-stats").innerHTML = rows
    .map(([k, v, warn]) => `<dt>${esc(k)}</dt><dd${warn ? ' class="warn"' : ""}>${esc(v)}</dd>`)
    .join("");
}

async function iaRenderVersions(id, current) {
  let list = [];
  try {
    list = await invoke("ia_versions", { id });
  } catch {}
  $("ia-vlabel").textContent = current ? `v${current}` : "";
  $("ia-versions").innerHTML = list
    .map(
      (v) =>
        `<button class="ia-ver${v.n === current ? " on" : ""}" data-v="${v.n}"
          title="${esc(tr(v.n === 1 ? "ia.version.first" : "ia.version.revert"))}">v${v.n}</button>`
    )
    .join("");
}

/* An object created from scratch has nothing to show before its first
   export: the pane says so, and nothing can be saved or sliced yet. */
function iaWaiting(on) {
  $("ia-wait").classList.toggle("hidden", !on);
  $("ia-save").disabled = on;
  $("ia-slice").disabled = on;
  if (on) iaUndock();
}

/* Reloads the object shown. The stamp busts the cache: the address never
   changes, and the old mesh would be served again. */
async function iaShowCurrent(id) {
  const c = IA.list.find((x) => x.id === id);
  if (iaEmpty(c)) {
    iaWaiting(true);
    return;
  }
  iaWaiting(false);
  try {
    const { path, stamp } = await invoke("ia_current", { id });
    iaDock();
    await openViewer(path, c ? c.title : "", "3mf", stamp);
  } catch (e) {
    $("ia-stats").innerHTML = `<dt>${esc(tr("ia.stats.object"))}</dt><dd class="warn">${esc(String(e))}</dd>`;
  }
}

/* Pane loads are chained: two close writes by Claude would otherwise start
   two reads where the older may finish last, and the object shown would no
   longer match the measurements beside it. */
let iaChain = Promise.resolve();
const iaQueue = (fn) => (iaChain = iaChain.then(fn).catch(() => {}));

async function iaLoadPane(id) {
  let version = 0;
  try {
    const c = await invoke("ia_get", { id });
    version = c.version;
    const known = IA.list.find((x) => x.id === id);
    if (known) known.version = version;
  } catch {}
  await iaShowCurrent(id);
  await iaRenderVersions(id, version);
  try {
    iaRenderStats(await invoke("ia_stats", { id }));
  } catch {
    $("ia-stats").innerHTML = "";
  }
}

/* Claude just wrote: the object changes before the user's eyes. */
listen("ia-mesh", async (e) => {
  const { id, version, stats } = e.payload;
  const c = IA.list.find((x) => x.id === id);
  if (c) c.version = version;
  if (IA.open !== id) return;
  iaQueue(async () => {
    await iaShowCurrent(id);
    await iaRenderVersions(id, version);
    iaRenderStats(stats);
  });
});

/* Conversation or terminal: the same Claude session, never both at once —
   the process of one view ends before the other resumes the transcript. */
async function iaSwitchView(view) {
  if (view === IA.view) return;
  const id = IA.open;
  IA.view = view;
  localStorage.setItem("snapstudio.iaview", view);
  if (!id) return;
  if (view === "term") {
    chatLeave();
    await invoke("ia_chat_close", { id }).catch(() => {});
    // The terminal resumes the session at once, not through "Reopen".
    const t = IA.terms.get(id);
    if (t) t.dead = false;
  } else {
    await invoke("pty_close", { id }).catch(() => {});
  }
  if (IA.open === id) iaOpen(id);
}

$("ia-views").addEventListener("click", (e) => {
  const b = e.target.closest("[data-iaview]");
  if (b) iaSwitchView(b.dataset.iaview);
});

/* Makes version `n` the current state again. */
async function iaShowVersion(id, n) {
  try {
    await invoke("ia_revert", { id, n });
    await iaQueue(() => iaLoadPane(id));
  } catch (e) {
    toast(String(e), true);
  }
}

$("ia-versions").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-v]");
  if (btn && IA.open) iaShowVersion(IA.open, +btn.dataset.v);
});

const iaStageObserver = new ResizeObserver(() => {
  if (IA.open && typeof draw === "function") draw();
});
iaStageObserver.observe($("ia-stage"));

/* ------------------------------------------------------------ output */

/* Saves the current state into your files and returns its path. The 3MF
   joins the original object's folder (or the chosen one), under a free name. */
async function iaSave(then) {
  if (!IA.open) return;
  const btns = [$("ia-save"), $("ia-slice")];
  btns.forEach((b) => (b.disabled = true));
  try {
    const path = await invoke("ia_save", { id: IA.open });
    const c = IA.list.find((x) => x.id === IA.open);
    if (c) c.saved = path;
    await refresh();
    toast(tr("ia.saved_toast", { name: path.split("/").pop() }));
    if (then) await then(path);
  } catch (e) {
    toast(String(e), true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

$("ia-save").addEventListener("click", () => iaSave());

/* Slice goes on to the plate, the freshly written file being a file like
   any other — even stored outside the folder shown, as a created object may
   be. */
$("ia-slice").addEventListener("click", () =>
  iaSave(async (path) => {
    iaBack();
    switchView("prepare");
    await prepareAddFile(path);
  })
);

$("ia-reframe").addEventListener("click", () => {
  if (typeof frameCamera === "function") frameCamera();
});

$("ia-expand").addEventListener("click", iaExpand);
$("ia-stage").addEventListener("dblclick", iaExpand);

window.addEventListener("langchange", () => {
  iaRender();
  if (IA.open) {
    const c = IA.list.find((x) => x.id === IA.open);
    if (c) iaHint(c);
    if (IA.stats) iaRenderStats(IA.stats);
    iaRenderVersions(IA.open, c?.version || 0);
  }
  if (!$("iamodal").classList.contains("hidden")) {
    const create = IA.mode === "create";
    $("ia-mtitle").textContent = tr(create ? "ia.new_object" : "ia.new.title");
    $("ia-plabel").textContent = tr(create ? "ia.new.describe" : "ia.new.what");
    $("ia-prompt").placeholder = tr(create ? "ia.new.placeholder_create" : "ia.new.placeholder_edit");
    $("ia-hints").textContent = tr(create ? "ia.new.hints_create" : "ia.new.hints_edit");
  }
});

// Conversations listed from launch, in the sidebar.
iaRefresh();
