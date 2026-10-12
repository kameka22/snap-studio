"use strict";
/* Assistant de bienvenue.

   Quatre étapes : bienvenue, dossier de modèles, imprimante (recherche réseau
   ou saisie), récapitulatif et « Commencer ». Il s'ouvre au premier lancement —
   aucun dossier ni imprimante connus — puis à la demande (Réglages, menu
   Aide). Fin ou « Ignorer » : il ne revient plus de lui-même. */

const W = {
  open: false,
  step: 0,
  dir: null,
  added: [],
  confetti: 0,
};
const W_STEPS = 4;
const W_KEY = "snapstudio.welcome";
const W_ORCA = "https://github.com/Snapmaker/OrcaSlicer/releases/latest";

const W_CHECK = '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>';
const W_WARN = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>';
const W_SKIP = '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>';

/* ------------------------------------------------------------ navigation */

function welcomeOpen() {
  W.open = true;
  W.step = 0;
  W.dir = null;
  W.added = [];
  $("w-folder").classList.add("hidden");
  $("w-added").classList.add("hidden");
  $("w-form").classList.add("hidden");
  $("w-manual").classList.remove("hidden");
  $("welcome").classList.remove("hidden", "closing");
  wRenderPlaces();
  wGo(0);
}

function wGo(n) {
  const from = W.step;
  W.step = Math.max(0, Math.min(W_STEPS - 1, n));
  // La recherche réseau ne tourne que sur l'étape Imprimante.
  if (from === 2 && W.step !== 2) discoverStop();
  if (W.step === 2 && (from !== 2 || !DISC.view)) discoveryList($("w-disc"), wPick);
  if (W.step === 3) wSummary();
  $("w-track").style.transform = `translateX(${-100 * W.step}%)`;
  document.querySelectorAll("#welcome .w-step").forEach((el, i) => {
    el.classList.toggle("on", i === W.step);
    el.inert = i !== W.step;
  });
  document.querySelectorAll("#w-dots i").forEach((d, i) => d.classList.toggle("on", i === W.step));
  wNav();
}

/* Boutons du bas : « Passer » tant que l'étape n'est pas remplie. */
function wNav() {
  const last = W.step === W_STEPS - 1;
  $("w-back").classList.toggle("invisible", W.step === 0);
  $("w-next").classList.toggle("invisible", last);
  $("w-skip").classList.toggle("invisible", last);
  const done = W.step === 1 ? !!W.dir : W.step === 2 ? W.added.length > 0 : true;
  $("w-next").textContent = done ? "Continuer" : "Passer";
  $("w-next").classList.toggle("primary", done);
}

function welcomeClose() {
  localStorage.setItem(W_KEY, JSON.stringify({ done: true, at: Date.now() }));
  discoverStop();
  cancelAnimationFrame(W.confetti);
  W.open = false;
  const el = $("welcome");
  el.classList.add("closing");
  setTimeout(() => el.classList.add("hidden"), 260);
}

/* « Commencer » : l'application s'ouvre sur ce qui vient d'être configuré. */
async function welcomeStart() {
  const dir = W.dir, printers = W.added.length;
  welcomeClose();
  if (dir) {
    switchView("files");
    await openDir(dir);
  } else if (printers) {
    switchView("printers");
  }
}

/* ------------------------------------------------------------ dossier */

async function wRenderPlaces() {
  const box = $("w-places");
  box.innerHTML = "";
  const places = await invoke("quick_places").catch(() => []);
  for (const p of places) {
    const b = document.createElement("button");
    b.className = "place";
    b.textContent = p.label;
    b.title = p.path;
    b.dataset.path = p.path;
    b.onclick = () => wSetDir(p.path);
    box.appendChild(b);
  }
}

async function wSetDir(dir) {
  W.dir = dir;
  document.querySelectorAll("#w-places .place").forEach((b) => b.classList.toggle("on", b.dataset.path === dir));
  const box = $("w-folder");
  box.classList.remove("hidden");
  box.innerHTML = `${W_CHECK}<span><b>${esc(dir.split(/[\\/]/).pop() || dir)}</b><small>${esc(dir)}</small></span>`;
  wNav();
  const files = await invoke("scan_folder", { dir, recursive: false }).catch(() => null);
  if (W.dir !== dir || !files) return;
  const n = files.length;
  box.querySelector("small").textContent =
    `${dir} · ${n ? `${n.toLocaleString("fr-FR")} modèle${n > 1 ? "s" : ""}` : "aucun modèle pour l'instant"}`;
}

/* ------------------------------------------------------------ imprimante */

function wPick(f) {
  $("w-form").classList.remove("hidden");
  $("w-manual").classList.add("hidden");
  $("w-pname").value = f.name;
  $("w-phost").value = f.ip;
  $("w-pport").value = 7125;
  wProbe();
}

async function wProbe() {
  const host = $("w-phost").value.trim();
  const box = $("w-ptest");
  if (!host) {
    box.className = "pf-test err";
    box.textContent = "Indiquez l'adresse IP ou le nom d'hôte de l'imprimante.";
    return null;
  }
  box.className = "pf-test";
  box.textContent = "Test en cours…";
  const r = await invoke("printer_probe", { host, port: +$("w-pport").value || 7125 });
  box.className = "pf-test " + (r.ok ? "ok" : "err");
  box.textContent = r.detail;
  if (r.ok) {
    $("w-pport").value = r.port;
    if (!$("w-pname").value.trim() && r.hostname) $("w-pname").value = r.hostname;
  }
  return r;
}

async function wAdd() {
  const host = $("w-phost").value.trim();
  if (!host) return wProbe();
  const found = [...DISC.items.values()].find((f) => f.ip === host);
  const printer = {
    id: "",
    name: $("w-pname").value.trim() || host,
    host,
    port: +$("w-pport").value || 7125,
    model: found ? discModel(found) : "Snapmaker U1",
    note: "",
  };
  try {
    P.list = await invoke("printer_save", { printer });
    W.added.push(printer.name);
    await prnLoad();
    $("w-form").classList.add("hidden");
    $("w-manual").classList.remove("hidden");
    $("w-ptest").textContent = "";
    const box = $("w-added");
    box.classList.remove("hidden");
    box.innerHTML = `${W_CHECK}<span><b>${W.added.map(esc).join(", ")}</b><small>${
      W.added.length > 1 ? "ajoutées" : "ajoutée"
    } à vos imprimantes</small></span>`;
    DISC.picked = null;
    discRender();
    wNav();
  } catch (e) {
    $("w-ptest").className = "pf-test err";
    $("w-ptest").textContent = "Enregistrement impossible : " + e;
  }
}

/* ------------------------------------------------------------ fin */

async function wSummary() {
  const ul = $("w-summary");
  const row = (ok, title, sub, extra = "") =>
    `<li class="${ok === true ? "ok" : ok === false ? "warn" : "skip"}">${ok === true ? W_CHECK : ok === false ? W_WARN : W_SKIP}
      <span><b>${title}</b><small>${sub}</small>${extra}</span></li>`;
  const folder = W.dir
    ? row(true, "Dossier de modèles", esc(W.dir))
    : row(null, "Dossier de modèles", "À choisir plus tard dans Fichiers");
  const printers = W.added.length
    ? row(true, W.added.length > 1 ? "Imprimantes" : "Imprimante", W.added.map(esc).join(", "))
    : row(null, "Imprimante", "À ajouter plus tard depuis la barre latérale");
  ul.innerHTML = folder + printers + row(true, "Snapmaker Orca", "Recherche…");
  const slicers = await invoke("slicers_list").catch(() => []);
  const orca = slicers.find((s) => s.name === "Snapmaker Orca");
  const html = orca
    ? row(true, "Snapmaker Orca", "Détecté : la découpe est disponible")
    : row(false, "Snapmaker Orca non trouvé", "Il est nécessaire pour découper", ' <button class="w-link" id="w-orca">Télécharger</button>');
  ul.lastElementChild.outerHTML = html;
  $("w-orca")?.addEventListener("click", () =>
    invoke("plugin:opener|open_url", { url: W_ORCA }).catch((e) => toast(String(e), true))
  );
  wConfetti();
}

/* Éclat de confettis aux couleurs des quatre têtes de la U1, une fois. */
function wConfetti() {
  cancelAnimationFrame(W.confetti);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("w-confetti");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const colors = TOOL_COLORS.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  const parts = Array.from({ length: 110 }, () => {
    const a = Math.random() * Math.PI * 2, v = 2.5 + Math.random() * 5.5;
    return {
      x: w / 2, y: h / 2,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      s: 4 + Math.random() * 5,
      c: colors[(Math.random() * colors.length) | 0],
    };
  });
  const t0 = performance.now();
  const frame = (t) => {
    const k = (t - t0) / 1800;
    ctx.clearRect(0, 0, w, h);
    if (k >= 1) return;
    ctx.globalAlpha = 1 - k * k;
    for (const p of parts) {
      p.vy += 0.16;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    W.confetti = requestAnimationFrame(frame);
  };
  W.confetti = requestAnimationFrame(frame);
}

/* ------------------------------------------------------------ événements */

$("w-next").addEventListener("click", () => wGo(W.step + 1));
$("w-back").addEventListener("click", () => wGo(W.step - 1));
$("w-skip").addEventListener("click", welcomeClose);
$("w-start").addEventListener("click", welcomeStart);
$("w-pick").addEventListener("click", async () => {
  const dir = await invoke("pick_folder");
  if (dir) wSetDir(dir);
});
$("w-manual").addEventListener("click", () => {
  $("w-form").classList.remove("hidden");
  $("w-manual").classList.add("hidden");
  $("w-pname").value = "";
  $("w-phost").value = "";
  $("w-pport").value = 7125;
  $("w-ptest").textContent = "";
  DISC.picked = null;
  discRender();
  $("w-phost").focus();
});
$("w-ptry").addEventListener("click", wProbe);
$("w-padd").addEventListener("click", wAdd);
$("w-again").addEventListener("click", welcomeOpen);
onMenu("welcome", welcomeOpen);

document.addEventListener("keydown", (e) => {
  if (!W.open) return;
  const typing = e.target.closest("input, textarea, select");
  if (e.key === "Enter") {
    e.preventDefault();
    if (typing && W.step === 2) wAdd();
    else if (W.step === W_STEPS - 1) welcomeStart();
    else if (!e.target.closest("button")) wGo(W.step + 1);
  } else if (!typing && (e.key === "ArrowLeft" || (e.metaKey && e.key === "["))) {
    wGo(W.step - 1);
  } else if (!typing && e.key === "ArrowRight") {
    wGo(W.step + 1);
  }
  // Les raccourcis de l'application ne traversent pas l'assistant.
  e.stopPropagation();
}, true);

/* Premier lancement : rien n'est encore configuré. Un utilisateur existant
   (ou repris de 3MF Studio) a déjà un dossier ou une imprimante. */
(async () => {
  if (localStorage.getItem(W_KEY)) return;
  const printers = await invoke("printers_list").catch(() => []);
  if (state.dir || state.recents.length || printers.length) {
    localStorage.setItem(W_KEY, JSON.stringify({ done: true, existing: true }));
    return;
  }
  welcomeOpen();
})();
