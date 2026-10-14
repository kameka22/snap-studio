"use strict";
/* Bundled slicing engine: status, download, progress.

   The same block shows in three places — welcome assistant, slice sheet,
   Settings. Each place "mounts" it on a container; the installation and its
   progress are reflected everywhere at once. */

const ENG = {
  status: null,
  installing: false,
  progress: null,
  error: null,
  /* Mounted containers: element → { onDone, settings } */
  mounts: new Map(),
};

async function engStatus() {
  ENG.status = await invoke("engine_status").catch(() => null);
  return ENG.status;
}

/* An engine is expected but not there yet. */
const engNeeded = () => !!ENG.status?.referenced && ENG.status.available && !ENG.status.installed;
const fmtMo = (b) => `${fmtNum(Math.max(1, Math.round(b / 1e6)))} ${tr("units.size").split(" ")[2]}`;

/* Mounts the block on `box`. `onDone`: called once the engine is installed;
   `settings`: the Settings variant (Reinstall, Delete, license). */
function engMount(box, opts = {}) {
  ENG.mounts.set(box, opts);
  box.classList.add("eng");
  engPaint();
}

function engUnmount(box) {
  ENG.mounts.delete(box);
}

const ENG_PHASES = ["download", "verify", "extract", "done"];

function engHtml(settings) {
  const s = ENG.status;
  if (!s) return `<div class="eng-text">${esc(tr("engine.unknown"))}</div>`;
  const name = `Snapmaker Orca ${esc(s.version)}`;
  if (!s.referenced) {
    return `<div class="eng-text"><b>${esc(tr("engine.dev"))}</b><small>${esc(tr("engine.dev.sub"))}</small></div>`;
  }
  if (!s.available) {
    return `<div class="eng-text"><b>${esc(tr("engine.unavailable"))}</b><small>${esc(tr("engine.unavailable.sub"))}</small></div>`;
  }
  if (ENG.installing) {
    const p = ENG.progress || { phase: "download", done: 0, total: s.download_size };
    const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
    const detail = p.phase === "download" ? " · " + tr("engine.of", { done: fmtMo(p.done), total: fmtMo(p.total) }) : "…";
    const phase = tr(ENG_PHASES.includes(p.phase) ? "engine.phase." + p.phase : "engine.phase.install");
    return `<div class="eng-text"><b>${esc(phase + detail)}</b><small>${esc(tr("engine.name", { name }))}</small></div>
      <div class="progress eng-bar"><i style="width:${Math.max(2, p.phase === "download" ? pct : 100)}%"></i></div>
      <div class="eng-actions">${p.phase === "download" ? `<button class="btn" data-eng="cancel">${esc(tr("common.cancel"))}</button>` : ""}</div>`;
  }
  if (s.installed) {
    return `<div class="eng-text"><b>✓ ${esc(tr("engine.installed", { name }))}</b><small>${esc(tr("engine.on_disk", { size: fmtMo(s.disk_size) }))}</small></div>
      ${
        settings
          ? `<div class="eng-actions"><button class="btn" data-eng="install">${esc(tr("engine.reinstall"))}</button><button class="btn danger" data-eng="remove">${esc(tr("common.delete"))}</button></div>`
          : ""
      }`;
  }
  // An older engine is there: this is an update, not an installation.
  const title = s.previous
    ? tr("engine.update_title", { from: s.previous, to: s.version })
    : tr("engine.to_download");
  const sizes = tr("engine.sizes", { dl: fmtMo(s.download_size), disk: fmtMo(s.disk_size) });
  return `<div class="eng-text"><b>${esc(title)}</b><small>${name} · ${esc(sizes)}</small>
      ${ENG.error ? `<small class="eng-err">${esc(ENG.error)}</small>` : ""}</div>
    <div class="eng-actions"><button class="btn primary" data-eng="install">${esc(
      tr(ENG.error ? "common.retry" : s.previous ? "engine.update" : "common.download")
    )}</button></div>`;
}

function engPaint() {
  for (const [box, opts] of ENG.mounts) {
    if (!box.isConnected) {
      ENG.mounts.delete(box);
      continue;
    }
    box.innerHTML =
      engHtml(opts.settings) +
      (opts.settings && ENG.status?.source
        ? `<button class="w-link eng-source" data-eng="source">${esc(tr("engine.license"))}</button>`
        : "");
  }
}

async function engInstall({ silent = false } = {}) {
  if (ENG.installing) return;
  ENG.installing = true;
  ENG.error = null;
  ENG.progress = null;
  engPaint();
  const update = ENG.status?.previous;
  try {
    ENG.status = await invoke("engine_install");
    toast(update ? tr("engine.updated", { version: ENG.status.version }) : tr("engine.installed_toast"));
    for (const [, opts] of ENG.mounts) opts.onDone?.();
  } catch (e) {
    ENG.error = String(e);
    if (!silent) toast(tr("engine.error", { err: e }), true);
  } finally {
    ENG.installing = false;
    engPaint();
  }
}

listen("engine-progress", (e) => {
  ENG.progress = e.payload;
  engPaint();
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-eng]");
  if (!b) return;
  const act = b.dataset.eng;
  if (act === "install") engInstall();
  else if (act === "cancel") invoke("engine_cancel").catch(() => {});
  else if (act === "source") invoke("plugin:opener|open_url", { url: ENG.status.source }).catch((err) => toast(String(err), true));
  else if (act === "remove") {
    const ok = await confirmDelete(
      tr("engine.remove.title"),
      tr("engine.remove.text")
    );
    if (!ok) return;
    try {
      ENG.status = await invoke("engine_remove");
      toast(tr("engine.removed"));
    } catch (err) {
      toast(String(err), true);
    }
    engPaint();
  }
});

window.addEventListener("langchange", engPaint);

/* Initial status; Settings show it as soon as they open.

   After a Snap Studio update that references a new engine, it downloads at
   once, in the background: it will be ready when slicing. A first
   installation, though, stays up to the user (assistant, slice sheet,
   Settings). A failure stays silent here: the slice sheet will offer
   "Retry". */
engStatus().then(() => {
  engMount($("set-engine"), { settings: true });
  if (engNeeded() && ENG.status.previous) {
    setTimeout(() => engInstall({ silent: true }), 4000);
  }
});
