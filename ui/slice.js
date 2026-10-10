"use strict";
/* Découpe : choix des préréglages, réglages rapides, suivi du travail.
   Le moteur de Snapmaker Orca tourne en tâche de fond ; rien ne s'ouvre à
   l'écran, l'avancement arrive par l'évènement `slice-progress`. */

const SL = {
  lists: null,
  source: null,
  job: null,
  /* Dernier choix par imprimante, conservé entre deux lancements. */
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

const fillSelect = (el, items, value) => {
  el.innerHTML = items
    .map((p) => `<option value="${esc(p.name)}"${p.user ? ' data-user="1"' : ""}>${esc(p.name)}${p.user ? " — perso" : ""}</option>`)
    .join("");
  if (value && items.some((p) => p.name === value)) el.value = value;
};

/* ------------------------------------------------------------ ouverture */

async function openSlice() {
  const path = [...state.sel][0];
  const f = state.files.find((x) => x.path === path);
  if (!f) return;
  if (f.kind === "gcode") {
    toast("Ce fichier est déjà découpé", true);
    return;
  }
  SL.source = f;
  SL.job = null;
  $("s-file").textContent = f.name;
  setSliceMessage("");
  showSliceBusy(false);
  openSheet($("smodal"));

  try {
    const mem = SL.memory.last ? rememberFor(SL.memory.last) : {};
    SL.lists = await invoke("slice_lists", { machine: SL.memory.last || null });
    const chosen =
      SL.memory.last ||
      SL.lists.selected.machine ||
      (SL.lists.machines[0] && SL.lists.machines[0].name);
    fillSelect($("s-machine"), SL.lists.machines, chosen);
    await onMachineChange(mem);
  } catch (e) {
    setSliceMessage(String(e), "err");
  }
}

async function onMachineChange(mem) {
  const machine = $("s-machine").value;
  try {
    SL.lists = await invoke("slice_lists", { machine });
    const m = mem || rememberFor(machine);
    fillSelect($("s-process"), SL.lists.processes, m.process || SL.lists.selected.print);
    fillSelect($("s-filament"), SL.lists.filaments, m.filament || SL.lists.selected.filament);
    await loadDefaults(m.simple);
  } catch (e) {
    setSliceMessage(String(e), "err");
  }
}

/* Valeurs de départ : celles du préréglage, sauf si l'utilisateur en a déjà
   choisi d'autres pour cette imprimante. */
async function loadDefaults(saved) {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  if (!machine || !process) return;
  let d = {};
  try {
    d = await invoke("slice_defaults", { machine, process });
  } catch {}
  const v = { ...d, ...(saved || {}) };
  setRange("s-layer", v.layer_height ?? 0.2, (x) => x.toFixed(2).replace(".", ",") + " mm");
  setRange("s-infill", v.infill ?? 15, (x) => Math.round(x) + " %");
  setRange("s-walls", v.walls ?? 2, (x) => String(Math.round(x)));
  $("s-supports").checked = !!v.supports;
  $("s-brim").checked = !!v.brim;
}

function setRange(id, value, fmt) {
  const el = $(id);
  el.value = value;
  el.dataset.fmt = "1";
  $(id + "-val").textContent = fmt(+el.value);
  el.oninput = () => ($(id + "-val").textContent = fmt(+el.value));
}

function currentSimple() {
  return {
    layer_height: +$("s-layer").value,
    infill: +$("s-infill").value,
    walls: +$("s-walls").value,
    supports: $("s-supports").checked,
    brim: $("s-brim").checked,
  };
}

/* ------------------------------------------------------------ exécution */

function setSliceMessage(text, cls) {
  const el = $("s-msg");
  el.textContent = text;
  el.className = "pf-test" + (cls ? " " + cls : "");
}

function showSliceBusy(busy) {
  $("s-go").classList.toggle("hidden", busy);
  $("s-cancel").classList.toggle("hidden", busy);
  $("s-stop").classList.toggle("hidden", !busy);
  ["s-machine", "s-process", "s-filament", "s-layer", "s-infill", "s-walls", "s-supports", "s-brim"]
    .forEach((id) => ($(id).disabled = busy));
}

async function startSlice() {
  const machine = $("s-machine").value;
  const process = $("s-process").value;
  const filament = $("s-filament").value;
  if (!machine || !process || !filament) {
    setSliceMessage("Choisissez une imprimante, un profil et un filament.", "err");
    return;
  }
  const simple = currentSimple();
  remember(machine, { process, filament, simple });
  showSliceBusy(true);
  setSliceMessage("Préparation…", "busy");
  try {
    SL.job = await invoke("slice_start", {
      request: {
        source: SL.source.path,
        machine,
        process,
        filaments: [filament],
        simple,
      },
    });
  } catch (e) {
    showSliceBusy(false);
    setSliceMessage(String(e), "err");
  }
}

listen("slice-progress", async (e) => {
  const p = e.payload;
  if (!SL.job || p.id !== SL.job) return;
  const secs = p.elapsed_s.toFixed(0);
  if (p.phase === "preparation") {
    setSliceMessage("Préparation du modèle et des profils…", "busy");
  } else if (p.phase === "slicing") {
    setSliceMessage("Découpe en cours…", "busy");
    tickElapsed(p.elapsed_s);
  } else if (p.phase === "done") {
    stopElapsed();
    showSliceBusy(false);
    SL.job = null;
    closeSheet($("smodal"));
    toast(`Découpé en ${secs} s`);
    await revealResult(p.gcode);
  } else if (p.phase === "cancelled") {
    stopElapsed();
    showSliceBusy(false);
    SL.job = null;
    setSliceMessage("Découpe interrompue.", "");
  } else if (p.phase === "error") {
    stopElapsed();
    showSliceBusy(false);
    SL.job = null;
    setSliceMessage(p.message || "Le moteur s'est arrêté sans message.", "err");
  }
});

/* Le compteur tourne côté interface : le moteur ne rend la main qu'à la fin. */
let elapsedTimer = 0;
function tickElapsed(from) {
  stopElapsed();
  const t0 = Date.now() - from * 1000;
  elapsedTimer = setInterval(() => {
    setSliceMessage(`Découpe en cours… ${((Date.now() - t0) / 1000).toFixed(0)} s`, "busy");
  }, 500);
}
function stopElapsed() {
  clearInterval(elapsedTimer);
  elapsedTimer = 0;
}

/* Le G-code produit rejoint la galerie, puis s'ouvre dans le visualiseur. */
async function revealResult(gcode) {
  if (!gcode) return;
  await refresh();
  const f = state.files.find((x) => x.path === gcode);
  if (!f) {
    toast("G-code écrit dans " + gcode);
    return;
  }
  setSel([f.path], { scroll: true });
  openViewer(f.path, f.name, "gcode");
}

/* ------------------------------------------------------------ évènements */

$("act-slice").addEventListener("click", openSlice);
$("s-machine").addEventListener("change", () => onMachineChange(null));
$("s-process").addEventListener("change", () => loadDefaults(null));
$("s-go").addEventListener("click", startSlice);
$("s-cancel").addEventListener("click", () => closeSheet($("smodal")));
$("s-stop").addEventListener("click", () => {
  if (SL.job) invoke("slice_cancel", { id: SL.job });
});
document.addEventListener("keydown", (e) => {
  if ($("smodal").classList.contains("hidden")) return;
  if (e.key === "Escape" && !SL.job) closeSheet($("smodal"));
  if (e.key === "Enter" && !SL.job) startSlice();
});
