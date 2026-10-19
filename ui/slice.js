"use strict";
/* Slicing: printer and spools, presets, quick settings, then a preview
   of the result in the viewer, from which the G-code is saved or sent to
   the printer. The Snapmaker Orca engine runs in the background; its
   progress arrives through the `slice-progress` event. */

const SL = {
  lists: null,
  source: null,
  job: null,
  /* Saved printers and the spools read on the chosen one. */
  printers: [],
  slots: [],
  /* Filaments declared by the model: { filaments: [{index, kind, color}], used: [1, 2…] }. */
  models: [],
  /* Last preview produced, awaiting a decision. */
  preview: null,
  /* Choices kept: per machine preset, and the last printer. */
  memory: JSON.parse(localStorage.getItem("snapstudio.slice") || "{}"),
};

function rememberFor(machine) {
  return SL.memory[machine] || {};
}

function remember(machine, data) {
  SL.memory[machine] = { ...rememberFor(machine), ...data };
  SL.memory.last = machine;
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

function rememberPrinter(id) {
  SL.memory.printer = id;
  localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
}

const fillSelect = (el, items, value) => {
  el.innerHTML = items
    .map((p) => `<option value="${esc(p.name)}"${p.user ? ' data-user="1"' : ""}>${esc(p.name)}${p.user ? " — perso" : ""}</option>`)
    .join("");
  if (value && items.some((p) => p.name === value)) el.value = value;
};

/* ------------------------------------------------------------ colors */

const hexToRgb = (h) => {
  const m = /^#?([0-9a-f]{6})/i.exec(h || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const colorDistance = (a, b) => {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return 1e9;
  return (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2;
};
const swatch = (color) =>
  `<span class="swatch${color ? "" : " none"}" style="${color ? `background:${esc(color)}` : ""}"></span>`;

/* ------------------------------------------------------------ opening */

/* Slicing works on the Prepare view's plate. */
async function openSlice() {
  // A plate from an older version may still be reading its colors: each one
  // needs a head, or the engine gets it on T0.
  if (typeof prRefreshColors === "function") await prRefreshColors();
  const scene = prepareScene();
  if (!scene) return;
  SL.source = scene;
  SL.job = null;
  SL.touched = new Set();
  slFileLine();
  setSliceMessage("");
  setSliceProgress(null);
  showSliceBusy(false);
  // Thumbnail of the plate's first object, if it can be read.
  const first = scene.items[0]?.path;
  const th = $("s-thumb");
  th.classList.add("hidden");
  if (first) {
    th.onload = () => th.classList.remove("hidden");
    th.onerror = () => th.classList.add("hidden");
    th.src = thumbSrc(first, 160, 0);
  }
  openSheet($("smodal"));

  // Engine expected but missing: the sheet first offers to download it.
  await engStatus();
  if (engNeeded()) {
    slEngineGate(true);
    return;
  }
  slEngineGate(false);
  await sliceLoad();
}

/* Objects on the plate, and those left off it. */
function slFileLine() {
  const scene = SL.source;
  $("s-file").textContent =
    tr("slice.objects", { n: scene.items.length }) +
    (scene.skipped ? " · " + tr("slice.skipped", { n: scene.skipped }) : "");
}

/* The engine is missing: its card replaces the content, slicing waits. */
function slEngineGate(on) {
  $("s-engine").classList.toggle("hidden", !on);
  document.querySelector("#smodal .sl-box").classList.toggle("needs-engine", on);
  $("s-go").disabled = on;
  if (on) {
    engMount($("s-engine"), {
      onDone: () => {
        engUnmount($("s-engine"));
        slEngineGate(false);
        sliceLoad();
      },
    });
  }
}

/* Printers, model colors, profiles: the sheet's content. */
async function sliceLoad() {
  try {
    const [printers, ...models] = await Promise.all([
      invoke("printers_list").catch(() => []),
      ...SL.source.files.map((path) => invoke("slice_model", { path }).catch(() => null)),
    ]);
    SL.printers = printers;
    // Model colors, file by file.
    SL.models = SL.source.files.map((path, i) => {
      const m = models[i];
      return {
        path,
        stem: path.split("/").pop().replace(/\.(3mf|stl)$/i, ""),
        filaments: m?.filaments || [],
        used: m?.used?.length ? m.used : [1],
      };
    });
    slGroupObjects();
    const opts = [{ id: "", name: tr("slice.no_printer") }, ...printers];
    $("s-printer").innerHTML = opts
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.host)}</option>`)
      .join("");
    const keep = printers.some((p) => p.id === SL.memory.printer) ? SL.memory.printer : printers[0]?.id || "";
    $("s-printer").value = keep;
    SL.pstate = {};
    slRenderPrinters();
    await onPrinterChange();
  } catch (e) {
    setSliceMessage(String(e), "err");
  }
}

const currentPrinter = () => SL.printers.find((p) => p.id === $("s-printer").value) || null;

/* A chosen printer imposes its machine and gets its spools read. */
async function onPrinterChange() {
  const printer = currentPrinter();
  SL.slots = [];
  $("s-heads-note").textContent = printer ? tr("slice.reading_spools") : "";
  slPrinterState(printer ? "checking" : null);
  SL.lists = await invoke("slice_lists", { machine: SL.memory.last || null });

  const machines = SL.lists.machines;
  let machine = SL.memory.last || SL.lists.selected.machine || machines[0]?.name;
  if (printer) {
    const saved = SL.memory["printer:" + printer.id];
    machine = (saved && machines.some((m) => m.name === saved) && saved) || matchMachine(printer, machines, machine) || machine;
  }
  fillSelect($("s-machine"), machines, machine);
  slRenderMachine();
  await onMachineChange(null);

  if (printer) {
    try {
      const st = await invoke("printer_status", { host: printer.host, port: printer.port });
      // Its state holds even if the user moved to another one meanwhile.
      slPrinterState(st.online ? st.state : "offline", printer.id);
      if (currentPrinter() !== printer) return;
      SL.slots = st.filaments || [];
      if (st.online) headsSetSlots(printer.id, SL.slots);
      $("s-heads-note").textContent = tr(!st.online
        ? "prints.unreachable"
        : SL.slots.length ? "slice.spools_read" : "slice.spools_hidden");
    } catch {
      slPrinterState("offline", printer.id);
      if (currentPrinter() !== printer) return;
      $("s-heads-note").textContent = tr("prints.unreachable");
    }
    renderHeads(null, true);
    renderModelMap(true);
  }
}

/* Machine preset whose name contains the printer's model. */
/* On a tie (U1 profiles only differ by nozzle), `preferred` — the profile
   already chosen in Orca or here — wins, then the 0.4 nozzle. */
function matchMachine(printer, machines, preferred) {
  const words = (printer.model || printer.name || "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return null;
  const scored = machines
    .map((m) => ({ m, n: words.filter((w) => m.name.toLowerCase().includes(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.m.name.length - b.m.name.length);
  if (!scored.length) return null;
  const top = scored.filter((x) => x.n === scored[0].n).map((x) => x.m.name);
  return top.find((n) => n === preferred) || top.find((n) => /\(0\.4 nozzle\)/i.test(n)) || top[0];
}

/* The machine's plates: the choice sets the bed temperature, read from the
   filament profile for that plate type. */
function fillBeds(saved) {
  const sel = $("s-bed");
  const types = SL.lists?.bed_types || [];
  sel.innerHTML = types.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join("");
  sel.value = types.some((t) => t.value === saved) ? saved : SL.lists?.bed_type || types[0]?.value || "";
  // Tiles: one per plate, with the temperature it will give.
  const tex = { "Textured PEI Plate": "textured", "High Temp Plate": "smooth", "Graphic Effect Plate": "graphic" };
  $("s-beds").innerHTML = types
    .map(
      (t) => `<button class="sl-bed${t.value === sel.value ? " on" : ""}" data-bed="${esc(t.value)}">
        <span class="sl-bed-tex ${tex[t.value] || "plain"}"></span>
        <b>${esc(t.label)}</b><small data-bedtemp="${esc(t.value)}">—</small></button>`
    )
    .join("");
}

$("s-beds").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bed]");
  if (!b || b.disabled) return;
  $("s-bed").value = b.dataset.bed;
  document.querySelectorAll("#s-beds .sl-bed").forEach((x) => x.classList.toggle("on", x === b));
  $("s-bed").dispatchEvent(new Event("change", { bubbles: true }));
  slSummary();
});

async function onMachineChange(mem) {
  const machine = $("s-machine").value;
  try {
    SL.lists = await invoke("slice_lists", { machine });
    const m = mem || rememberFor(machine);
    // The first choice known and offered for this machine; failing that, the
    // standard 0.20 mm profile.
    const known = (n) => n && SL.lists.processes.some((p) => p.name === n);
    fillSelect($("s-process"), SL.lists.processes, [m.process, SL.lists.selected.print].find(known) || slProcessFor(0.2, "Standard"));
    slRenderMachine();
    slQuality();
    fillBeds(m.bed);
    renderHeads(m.filaments || (m.filament ? [m.filament] : null), false);
    renderModelMap(false);
    await loadDefaults(m.simple);
    advLoad(m.adv);
  } catch (e) {
    setSliceMessage(String(e), "err");
  }
}

/* ------------------------------------------------------------ heads */

const headCount = () => Math.max(1, SL.lists?.extruders || 1);

/* Closest preset to a spool: material required, then vendor, then
   sub-type; a generic preset serves as fallback. */
function bestFilament(slot, list) {
  const kind = (slot.kind || "").trim().toUpperCase();
  if (!kind) return null;
  const vendor = (slot.vendor || "").trim().toLowerCase();
  const sub = (slot.sub_type || "").trim().toLowerCase();
  let best = null, bestScore = -1;
  for (const p of list) {
    const t = (p.ftype || "").toUpperCase();
    if (t !== kind) continue;
    const name = p.name.toLowerCase();
    let score = 10;
    if (vendor && ((p.vendor || "").toLowerCase().includes(vendor) || name.includes(vendor))) score += 5;
    if (sub && name.includes(sub)) score += 3;
    if (!vendor && /generic|générique/.test(name)) score += 2;
    if (!sub && /basic/.test(name)) score += 1;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best?.name || null;
}

/* One row per head: real spool (if known) and filament preset. */
function renderHeads(saved, fromPrinter) {
  const list = SL.lists?.filaments || [];
  const fallback = SL.lists?.selected?.filament || list[0]?.name;
  const prev = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  const rows = [];
  for (let i = 0; i < headCount(); i++) {
    const slot = SL.slots.find((s) => s.index === i);
    const auto = slot && slot.present ? bestFilament(slot, list) : null;
    // The profile set in "Heads and spools" for this printer wins.
    const pid = currentPrinter()?.id;
    const shared = pid ? headsFilaments(pid)[i] : null;
    const chosen = (shared && list.some((p) => p.name === shared) && shared) || (fromPrinter && auto) || saved?.[i] || prev[i] || auto || fallback;
    // Spool card: real color as a flat fill, material, chosen preset.
    const present = slot?.present;
    const kind = present ? [slot.kind, slot.sub_type].filter(Boolean).join(" ") || "?" : slot ? tr("slice.empty") : "";
    const sub = present
      ? slot.vendor || (auto ? "" : tr("slice.no_preset", { kind: slot.kind || "" }))
      : tr(slot ? "slice.no_spool" : "slice.spool_unknown");
    const color = present && slot.color ? slot.color : null;
    rows.push(`<div class="sl-headcard${slot && !present ? " is-empty" : ""}" data-card="${i}">
      <div class="sl-spool${color ? "" : " none"}"${color ? ` style="--c:${esc(color)}"` : ""}></div>
      <div class="sl-hc-top"><b>T${i}</b><span>${esc(kind)}</span></div>
      <small class="sl-hc-sub${present && !auto ? " warn" : ""}">${esc(sub)}</small>
      <select class="hidden" data-head="${i}" tabindex="-1">${list
        .map((p) => `<option value="${esc(p.name)}"${p.name === chosen ? " selected" : ""}>${esc(p.name)}</option>`)
        .join("")}</select>
      <span class="sel-row"><button class="sl-hc-preset" data-pick-head="${i}" title="${esc(tr("slice.change_filament"))}"></button><button class="btn info-btn" data-info="head" data-head="${i}" title="${esc(tr("slice.profile_details"))}">${INFO_ICON}</button></span>
      <small class="sl-hc-temp" data-temp="${i}"></small>
    </div>`);
  }
  $("s-heads").innerHTML = rows.join("");
  for (let i = 0; i < headCount(); i++) slHeadLabel(i);
  slUsedHeads();
  pdBedLine();
}

/* The plate's objects, identical ones grouped (same file, object and own
   choices): one block of colors each in the table. */
function slGroupObjects() {
  const groups = new Map();
  SL.source.items.forEach((it, i) => {
    const key = `${it.path}#${it.item}#${it.piece ?? ""}#${JSON.stringify(it.heads || {})}`;
    const g = groups.get(key);
    if (g) g.items.push(i);
    else groups.set(key, { key, items: [i], name: it.name, path: it.path, colors: it.colors?.length ? it.colors : [1], obj: { ...it, extruders: it.colors } });
  });
  SL.groups = [...groups.values()];
}

/* Heads chosen for each color of each object on the plate, as Prepare
   resolves them for the sheet's printer. */
function renderModelMap(fromPrinter) {
  const n = headCount();
  const prev = Object.fromEntries(
    [...document.querySelectorAll("#s-map select")].map((s) => [s.dataset.key, +s.value])
  );
  const several = SL.groups.length > 1;
  // Read-only: the heads come from Prepare's objects.
  const pid = currentPrinter()?.id;
  const rows = [];
  SL.groups.forEach((g, gi) => {
    const model = SL.models.find((m) => m.path === g.path);
    const heads = typeof prHeads === "function" ? prHeads(g.obj, pid || "", SL.slots, n) : {};
    const taken = new Set();
    const name = g.items.length > 1 ? `${g.name} ×${g.items.length}` : g.name;
    // Several colors: the object's name heads them, as in Prepare's list.
    const nested = several && g.colors.length > 1;
    if (nested) rows.push(`<div class="sl-mapobj">${esc(name)}</div>`);
    for (const e of g.colors) {
      const key = `${gi}:${e}`;
      const fil = model?.filaments.find((f) => f.index === e);
      let head = heads[e]?.h ?? (fromPrinter ? null : prev[key]);
      if (head == null || head >= n) head = autoHead(fil, e, taken);
      taken.add(head);
      const color = g.colors.length === 1 ? "" : tr("slice.color_n", { n: e });
      const label = nested ? color : several ? name : color || name;
      const sub = fil?.kind || "";
      rows.push(`<div class="sl-maprow${nested ? " nested" : ""}">
        ${swatch(fil?.color)}
        <span class="sl-map-label"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>
        <span class="sl-arrow">→</span>
        <span class="sl-tokens" data-tokens="${key}"></span>
        <select class="hidden" tabindex="-1" data-key="${key}" data-group="${gi}" data-ext="${e}">${Array.from({ length: n }, (_, h) => {
          const slot = SL.slots.find((s) => s.index === h);
          const desc = slot ? (slot.present ? ` · ${slot.kind || "?"}` : " · " + tr("printers.empty_tag")) : "";
          return `<option value="${h}"${h === head ? " selected" : ""}>T${h}${esc(desc)}</option>`;
        }).join("")}</select>
      </div>`);
    }
  });
  $("s-map").innerHTML = rows.join("");
  slUsedHeads();
  // Bed temperatures depend on the heads used.
  pdBedLine();
}

/* Heads used by the model: their card stands out, the others fade; each
   color's dot takes the targeted spool's. */
function slUsedHeads() {
  const used = slUsedSet();
  document.querySelectorAll("#s-heads .sl-headcard").forEach((c) => c.classList.toggle("unused", used.size > 0 && !used.has(+c.dataset.card)));
  slTokens();
  slSummary();
  return used;
}

/* Most likely head for a model color: same material and closest color
   among the spools present, without reusing a head already taken if
   possible. */
function autoHead(fil, ext, taken) {
  const n = headCount();
  const present = SL.slots.filter((s) => s.present && s.index < n);
  if (present.length) {
    const kind = (fil?.kind || "").toUpperCase();
    const ranked = present
      .map((s) => ({
        h: s.index,
        score: (kind && (s.kind || "").toUpperCase() === kind ? 0 : 1e7) + (fil?.color ? colorDistance(fil.color, s.color) : 0) + (taken.has(s.index) ? 1e8 : 0),
      }))
      .sort((a, b) => a.score - b.score);
    return ranked[0].h;
  }
  return (ext - 1) % n;
}

/* ------------------------------------------------------------ quick settings */

/* Starting values: the preset's, unless the user already chose others for
   this printer. */
async function loadDefaults(saved) {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  if (!machine || !process) return;
  let d = {};
  try {
    d = await invoke("slice_defaults", { machine, process });
  } catch {}
  const v = { ...d, ...(saved || {}) };
  // The layer height is the profile's ("Quality" chips): it is never
  // overridden, so it is read from its name or its values.
  const h = parseProcess(process)?.h ?? d.layer_height;
  $("s-layer-val").textContent = h ? `${fmtDec(+h, 2)} mm` : "—";
  setRange("s-infill", v.infill ?? 15, (x) => Math.round(x) + " %");
  setRange("s-walls", v.walls ?? 2, (x) => String(Math.round(x)));
  $("s-supports").checked = !!v.supports;
  $("s-brim").checked = !!v.brim;
  slQuality();
  slSummary();
}

document.querySelector("#smodal .sl-stepper").addEventListener("click", (e) => {
  const b = e.target.closest("[data-step]");
  if (!b) return;
  const el = $("s-walls");
  el.value = Math.max(+el.min, Math.min(+el.max, +el.value + +b.dataset.step));
  el.dispatchEvent(new Event("input"));
  slTouch("s-walls");
  slSummary();
});

/* Heads used by the model (colors → heads); empty if unknown. */
function slUsedSet() {
  return new Set([...document.querySelectorAll("#s-map select")].map((s) => +s.value));
}

/* Bottom bar: what will go to the engine, in one line. */
function slSummary() {
  const used = slUsedSet();
  const bed = $("s-bed").selectedOptions[0]?.textContent || "";
  const temp = typeof PD !== "undefined" ? PD.bedTemps?.[$("s-bed").value] : null;
  const n = used.size || 1;
  // Heads chosen for supports, walls or infill: discreetly, beside them.
  const heads = typeof advHeadsSummary === "function" ? advHeadsSummary() : null;
  const parts = [
    tr("slice.sum.spools", { n }),
    bed && `${bed}${temp ? ` ${temp}` : ""}`,
    $("s-layer-val").textContent,
    tr("slice.sum.infill", { v: $("s-infill-val").textContent }),
    tr("slice.sum.walls", { v: $("s-walls-val").textContent }),
    $("s-supports").checked && [tr("slice.sum.supports"), heads?.supports].filter(Boolean).join(" "),
    $("s-brim").checked && tr("slice.sum.brim"),
    heads?.others,
    typeof advCount === "function" && advCount() && tr("slice.sum.adv", { n: advCount() }),
  ].filter(Boolean);
  $("s-summary").innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join("");
}

/* Adjustments touched by hand: they survive a profile change. */
const SL_TOUCH = { "s-infill": "infill", "s-walls": "walls", "s-supports": "supports", "s-brim": "brim" };
function slTouch(id) {
  (SL.touched ||= new Set()).add(SL_TOUCH[id]);
}

$("smodal").addEventListener("input", (e) => {
  if (e.target.id in SL_TOUCH && e.isTrusted) slTouch(e.target.id);
  if (e.target.matches("#s-infill, #s-supports, #s-brim")) slSummary();
});
$("smodal").addEventListener("change", (e) => {
  if (e.target.matches("#s-map select")) slUsedHeads();
  if (e.target.matches("#s-supports, #s-brim")) slSummary();
  // Supports on or off change the heads counted for the plate.
  if (e.target.matches("#s-supports")) pdBedLine();
});

function setRange(id, value, fmt) {
  const el = $(id);
  el.value = value;
  el.dataset.fmt = "1";
  $(id + "-val").textContent = fmt(+el.value);
  el.oninput = () => ($(id + "-val").textContent = fmt(+el.value));
}

function currentSimple() {
  return {
    infill: +$("s-infill").value,
    walls: +$("s-walls").value,
    supports: $("s-supports").checked,
    brim: $("s-brim").checked,
  };
}

/* ------------------------------------------------------------ execution */

function setSliceMessage(text, cls) {
  const el = $("s-msg");
  el.textContent = text;
  el.className = "pf-test" + (cls ? " " + cls : "");
}

/* Progress bar; `null` hides it. */
function setSliceProgress(pct) {
  $("s-progress").classList.toggle("hidden", pct == null);
  if (pct != null) $("s-progress").firstElementChild.style.width = Math.max(2, pct) + "%";
}

function showSliceBusy(busy) {
  $("s-go").classList.toggle("hidden", busy);
  $("s-cancel").classList.toggle("hidden", busy);
  $("s-stop").classList.toggle("hidden", !busy);
  document
    .querySelectorAll("#smodal select, #smodal input, #smodal .sl-cols button:not(.info-btn)")
    .forEach((el) => (el.disabled = busy));
  if (busy) closePicker();
  // Unlocked: the chips of empty heads must stay inactive.
  else slTokens();
}

async function startSlice() {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  const filaments = [...document.querySelectorAll("#s-heads select")].map((s) => s.value);
  if (!machine || !process || !filaments.length || filaments.some((f) => !f)) {
    setSliceMessage(tr("slice.need_profiles"), "err");
    return;
  }
  // Model color → head, object by object; entry i is about color i + 1.
  const maps = SL.groups.map(() => []);
  document.querySelectorAll("#s-map select").forEach((s) => (maps[+s.dataset.group][+s.dataset.ext - 1] = +s.value));
  for (const m of maps) for (let i = 0; i < m.length; i++) if (m[i] == null) m[i] = 0;
  const groupOf = (i) => SL.groups.findIndex((g) => g.items.includes(i));
  const scene = SL.source.items.map(({ id, colors, heads, ...it }, i) => ({ ...it, extruder_map: maps[groupOf(i)] || [] }));
  const heads = [...new Set(maps.flat())];
  const empty = heads.filter((h) => SL.slots.find((s) => s.index === h && !s.present));
  if (empty.length) {
    setSliceMessage(tr("slice.head_empty", { heads: empty.map((h) => "T" + h).join(", ") }), "err");
    return;
  }
  const colors = filaments.map((_, i) => {
    const slot = SL.slots.find((s) => s.index === i);
    return slot?.present && slot.color ? slot.color : null;
  });

  const simple = currentSimple();
  const bed = $("s-bed").value;
  remember(machine, { process, filaments, simple, bed, adv: SL.adv || {} });
  const printer = currentPrinter();
  rememberPrinter(printer?.id || "");
  if (printer) {
    SL.memory["printer:" + printer.id] = machine;
    localStorage.setItem("snapstudio.slice", JSON.stringify(SL.memory));
  }

  showSliceBusy(true);
  setSliceMessage(tr("slice.preparing"), "busy");
  setSliceProgress(0);
  try {
    SL.job = await invoke("slice_start", {
      request: {
        source: "", scene, name: SL.source.name, machine, process, filaments, simple, colors,
        overrides: { ...advOverrides(), ...(bed ? { curr_bed_type: bed } : {}) },
      },
    });
    const bedLabel = $("s-bed").selectedOptions[0]?.textContent || "";
    SL.request = { printer: printer?.id || "", filaments, colors, machine, process, bed, bedLabel };
  } catch (e) {
    showSliceBusy(false);
    setSliceProgress(null);
    setSliceMessage(String(e), "err");
  }
}

listen("slice-progress", async (e) => {
  const p = e.payload;
  if (!SL.job || p.id !== SL.job) return;
  if (p.phase === "preparation") {
    setSliceMessage(tr("slice.preparing_model"), "busy");
  } else if (p.phase === "slicing") {
    if (p.percent != null) {
      stopElapsed();
      setSliceProgress(p.percent);
      setSliceMessage(`${p.message || tr("slice.slicing")} ${Math.round(p.percent)} %`, "busy");
    } else {
      tickElapsed(p.elapsed_s);
    }
  } else if (p.phase === "preview") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    const job = SL.job;
    SL.job = null;
    closeSheet($("smodal"));
    showPreview(job, p);
  } else if (p.phase === "cancelled") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    SL.job = null;
    setSliceMessage(tr("slice.stopped"), "");
  } else if (p.phase === "error") {
    stopElapsed();
    showSliceBusy(false);
    setSliceProgress(null);
    SL.job = null;
    setSliceMessage(p.message || tr("slice.engine_silent"), "err");
  }
});

/* The counter runs in the UI when the engine reports no progress. */
let elapsedTimer = 0;
function tickElapsed(from) {
  stopElapsed();
  const t0 = Date.now() - from * 1000;
  elapsedTimer = setInterval(() => {
    setSliceMessage(`${tr("slice.slicing")} ${Math.round((Date.now() - t0) / 1000)} s`, "busy");
  }, 500);
}
function stopElapsed() {
  clearInterval(elapsedTimer);
  elapsedTimer = 0;
}

/* ------------------------------------------------------------ preview */

function showPreview(job, p) {
  const req = SL.request || { filaments: [], colors: [] };
  SL.preview = { job, source: SL.source, gcode: p.gcode, stats: p.stats || {}, printer: req.printer, saved: null };
  const toolColors = req.filaments.map((_, i) => hexToRgb(req.colors[i]));
  const toolNames = req.filaments.map((name) => name.replace(/\s*@.*$/, ""));
  openPreview({
    path: p.gcode,
    name: SL.source.name + " — " + tr("ia.preview").toLowerCase(),
    stats: p.stats || {},
    toolColors,
    toolNames,
    onSend: openSend,
    onSave: savePreview,
    onEdit: () => {
      closeViewer();
      switchView("prepare");
      openSlice();
    },
    // Closing the preview deletes it: what was saved stays.
    onClose: () => {
      if (SL.preview) invoke("slice_discard", { id: SL.preview.job }).catch(() => {});
      SL.preview = null;
    },
  });
}

async function savePreview() {
  const pv = SL.preview;
  if (!pv) return;
  try {
    const path = await invoke("slice_save", { id: pv.job, dir: null });
    pv.saved = path;
    toast(tr("slice.gcode_saved", { name: path.split("/").pop() }));
    await refresh();
  } catch (e) {
    toast(String(e), true);
  }
}

/* ------------------------------------------------------------ sending */

async function openSend() {
  const pv = SL.preview;
  if (!pv) return;
  if (!SL.printers.length) SL.printers = await invoke("printers_list").catch(() => []);
  if (!SL.printers.length) {
    toast(tr("send.no_printer"), true);
    return;
  }
  $("snd-file").textContent = pv.source.name + (pv.stats.print_time_s ? " · " + fmtDuration(pv.stats.print_time_s) : "");
  $("snd-printer").innerHTML = SL.printers
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.host)}</option>`)
    .join("");
  $("snd-printer").value = SL.printers.some((p) => p.id === pv.printer) ? pv.printer : SL.printers[0].id;
  // Options always unticked on opening, as requested.
  ["snd-level", "snd-flow", "snd-timelapse"].forEach((id) => ($(id).checked = false));
  setSendBusy(false);
  setSendMessage("");
  setSendProgress(null);
  openSheet($("sendmodal"));
  checkSendPrinter();
}

const sendPrinter = () => SL.printers.find((p) => p.id === $("snd-printer").value);

/* Printer free: start, or queue. Busy or unreachable: only the queue. */
function setSendMode(mode) {
  SL.sendMode = mode;
  $("snd-go").textContent = tr(mode === "queue" ? "send.add_queue" : "send.go");
  $("snd-queue").classList.toggle("hidden", mode !== "launch");
}

/* State of the target printer: only start on an idle machine. */
async function checkSendPrinter() {
  const p = sendPrinter();
  const el = $("snd-state");
  $("snd-go").disabled = true;
  setSendMode("launch");
  $("snd-queue").classList.add("hidden");
  if (!p) return;
  el.className = "pf-test busy";
  el.textContent = tr("send.querying");
  const st = await invoke("printer_status", { host: p.host, port: p.port }).catch(() => null);
  if (sendPrinter() !== p) return;
  if (!st || !st.online) {
    el.className = "pf-test err";
    el.textContent = tr("send.no_answer", { name: p.name });
    setSendMode("queue");
    $("snd-go").disabled = false;
    return;
  }
  if (["printing", "paused"].includes(st.state)) {
    const end = st.remaining_s ? " — " + tr("send.ends_at", { time: fmtClock(Date.now() + st.remaining_s * 1000) }) : "";
    el.className = "pf-test warn";
    el.textContent = tr("send.busy", { name: p.name, job: (st.job || "").replace(/\.gcode$/, ""), end });
    setSendMode("queue");
    $("snd-go").disabled = false;
    return;
  }
  // G-code heads with no spool on this machine: to flag before sending.
  const tools = SL.preview?.stats?.tools || [];
  const missing = tools.filter((t) => (st.filaments || []).some((f) => f.index === t && !f.present));
  SL.sendSlots = st.filaments || [];
  el.className = "pf-test" + (missing.length ? " err" : " ok");
  el.textContent = missing.length
    ? tr("send.missing", { heads: missing.map((t) => "T" + t).join(", "), name: p.name })
    : tr("send.ready", { name: p.name });
  // With the spool check, another loaded spool can stand in for an empty head.
  $("snd-go").disabled = missing.length > 0 && !spEnabled();
  setSendMode("launch");
}

function setSendMessage(text, cls) {
  const el = $("snd-msg");
  el.textContent = text;
  el.className = "pf-test" + (cls ? " " + cls : "");
}
function setSendProgress(pct) {
  $("snd-progress").classList.toggle("hidden", pct == null);
  if (pct != null) $("snd-progress").firstElementChild.style.width = Math.max(2, pct) + "%";
}
function setSendBusy(busy) {
  SL.sending = busy;
  $("snd-go").classList.toggle("hidden", busy);
  // After a failure, the earlier choices come back (including "Add to Queue").
  if (busy) $("snd-queue").classList.add("hidden");
  else if (SL.sendMode) setSendMode(SL.sendMode);
  $("snd-cancel").classList.toggle("hidden", busy);
  ["snd-printer", "snd-level", "snd-flow", "snd-timelapse"].forEach((id) => ($(id).disabled = busy));
}

async function sendPrint(queue = SL.sendMode === "queue") {
  const pv = SL.preview, p = sendPrinter();
  if (!pv || !p || (!queue && $("snd-go").disabled)) return;
  const r = SL.request || {};
  const tools = pv.stats.tools?.length ? pv.stats.tools : [0];
  // Spools checked when the print starts now; a queued job is checked when
  // it starts from the queue.
  let map = [];
  if (!queue) {
    if (SL.checking) return;
    SL.checking = true;
    const slots = (await headsRefreshSlots(p.id)).length ? headsSlots(p.id) : SL.sendSlots || [];
    const ok = await spoolCheck({ pid: p.id, tools, profile: r, stats: pv.stats, slots }).finally(() => (SL.checking = false));
    if (!ok) return;
    map = ok.map;
  }
  setSendBusy(true);
  setSendProgress(queue ? null : 0);
  setSendMessage(tr(queue ? "send.queueing" : "send.preparing"), "busy");
  try {
    const id = await invoke("print_send", {
      request: {
        printer_id: p.id,
        job: pv.job,
        queue,
        tools,
        map,
        options: {
          bed_leveling: $("snd-level").checked,
          flow_calibration: $("snd-flow").checked,
          timelapse: $("snd-timelapse").checked,
        },
        profile: {
          machine: r.machine || "",
          process: r.process || "",
          filaments: r.filaments || [],
          bed: r.bed || null,
          bed_label: r.bedLabel || null,
          colors: r.colors || [],
        },
      },
    });
    if (!queue) {
      // The printers snapshot may still say "free": the record is designated by
      // the job, not by the printer.
      await pjLoad();
      pjShow(id ? "job:" + id : null);
    } else {
      setSendBusy(false);
      closeSheet($("sendmodal"));
      closeViewer();
      await pjLoad();
      const pos = pjQueue().findIndex((j) => j.id === id) + 1;
      toast(tr("send.queued", { name: p.name }) + (pos ? ` (${tr("prints.position", { n: pos })})` : ""));
      pjShow("job:" + id);
    }
  } catch (e) {
    setSendBusy(false);
    setSendProgress(null);
    setSendMessage(String(e), "err");
  }
}

listen("print-send", (e) => {
  if (!SL.sending) return;
  const s = e.payload;
  if (s.phase === "check") setSendMessage(tr("send.checking"), "busy");
  else if (s.phase === "prepare") setSendMessage(tr("send.preparing"), "busy");
  else if (s.phase === "upload") {
    setSendProgress(s.percent);
    setSendMessage(tr("send.uploading", { p: Math.round(s.percent || 0) }), "busy");
  } else if (s.phase === "done") {
    const p = sendPrinter();
    setSendBusy(false);
    closeSheet($("sendmodal"));
    toast(tr("send.started", { name: p?.name || tr("slice.printer") }));
    if (s.message) toast(s.message, true);
    closeViewer();
  }
});

/* ------------------------------------------------------------ events */

window.addEventListener("langchange", () => {
  if ($("smodal").classList.contains("hidden") || !SL.source) return;
  slFileLine();
  if (SL.lists) {
    renderHeads(null, false);
    renderModelMap(false);
    // Plate names come from Rust, in the language it now speaks.
    invoke("slice_lists", { machine: $("s-machine").value })
      .then((l) => {
        SL.lists.bed_types = l.bed_types;
        fillBeds($("s-bed").value);
        pdBedLine();
      })
      .catch(() => {});
  }
  slSummary();
});

$("s-printer").addEventListener("change", onPrinterChange);
$("s-machine").addEventListener("change", () => onMachineChange(null));
// Changing profile (height, style) applies its values, except for the
// adjustments the user already touched in this sheet.
$("s-process").addEventListener("change", () => {
  const cur = currentSimple();
  loadDefaults(Object.fromEntries([...(SL.touched || [])].map((k) => [k, cur[k]]))).then(advRefreshDefaults);
});
$("s-go").addEventListener("click", startSlice);
$("s-cancel").addEventListener("click", () => closeSheet($("smodal")));
$("s-stop").addEventListener("click", () => {
  if (SL.job) invoke("slice_cancel", { id: SL.job });
});
document.addEventListener("keydown", (e) => {
  if ($("smodal").classList.contains("hidden")) return;
  // A profile's details, open on top, keep their keys.
  if (!$("pdmodal").classList.contains("hidden")) return;
  if (!$("advsave").classList.contains("hidden")) return;
  // The advanced sub-panel closes first; its fields keep Enter.
  if (!$("s-adv").classList.contains("hidden")) {
    if (e.key === "Escape") advClose();
    return;
  }
  if (e.key === "Escape" && !SL.job) closeSheet($("smodal"));
  if (e.key === "Enter" && !SL.job && e.target.tagName !== "SELECT") startSlice();
});

$("snd-printer").addEventListener("change", checkSendPrinter);
$("snd-go").addEventListener("click", () => sendPrint());
$("snd-cancel").addEventListener("click", () => closeSheet($("sendmodal")));
$("snd-queue").addEventListener("click", () => sendPrint(true));
document.addEventListener("keydown", (e) => {
  if ($("sendmodal").classList.contains("hidden") || SL.sending) return;
  // The spool sheet, open on top, keeps its keys.
  if (!$("spmodal").classList.contains("hidden")) return;
  if (e.key === "Escape") closeSheet($("sendmodal"));
});
