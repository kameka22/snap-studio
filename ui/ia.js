"use strict";
/* Onglet IA : une conversation par objet.

   Chaque conversation possède son dossier de travail, préparé côté Rust :
   l'objet converti en STL, les consignes et les outils. Ici on ne fait que
   créer, lister et supprimer ; le terminal et le volet 3D viendront se poser
   dans l'écran de détail. */

const IA = {
  list: [],
  engine: null,
  /* Le fichier choisi dans Fichiers, le temps de la modale. */
  source: null,
  /* Conversation dont la suppression attend confirmation. */
  /* Conversation ouverte à l'écran, ou null si l'on est sur la liste. */
  open: null,
  /* Un émulateur par conversation : quitter l'onglet ne doit rien effacer.
     id -> { term, fit, el, dead } */
  terms: new Map(),
};

/* ------------------------------------------------------------ chargement */

async function iaRefresh() {
  try {
    IA.list = await invoke("ia_list");
  } catch (e) {
    IA.list = [];
  }
  iaRender();
  // L'état du bac à sable change sans prévenir — Docker se démarre et
  // s'arrête — et l'interroger prend un instant : on rafraîchit à côté.
  invoke("ia_engine")
    .then((e) => {
      IA.engine = e;
      if (!IA.open) iaRender();
    })
    .catch(() => {});
}

/* Le bac à sable n'est utilisable que si le démon répond : Docker installé
   mais arrêté est le cas le plus courant sur macOS. */
const iaSandboxReady = () => {
  const e = IA.engine || {};
  return !!(e.docker && e.daemon && e.yolobox);
};

function iaDefaultEngine() {
  return iaSandboxReady() ? "container" : "local";
}

function iaEngineLabel() {
  const e = IA.engine || {};
  if (!e.claude) return "Claude Code introuvable";
  if (iaSandboxReady()) return "Conteneur disponible";
  if (e.docker && e.yolobox && !e.daemon) return "Docker installé mais arrêté";
  return "Mode local";
}

/* Pourquoi le conteneur n'est pas proposé, dit en clair. */
function iaSandboxReason() {
  const e = IA.engine || {};
  if (iaSandboxReady()) return "Conteneur (isolé)";
  if (!e.docker) return "Conteneur — Docker absent";
  if (!e.daemon) return "Conteneur — Docker arrêté";
  return "Conteneur — yolobox absent";
}

/* ------------------------------------------------------------ affichage */

const iaWhen = (secs) => {
  const d = new Date(secs * 1000);
  const mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${Math.round(mins)} min`;
  if (mins < 60 * 24) return `il y a ${Math.round(mins / 60)} h`;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};

/* La vignette de l'objet d'origine, servie par le protocole des miniatures.
   Le rendu de l'état courant arrivera avec le volet 3D. */
const iaThumb = (c) =>
  `thumb://localhost/t?p=${encodeURIComponent(c.source)}&s=176&k=0&v=${c.created_at}`;

/* Source introuvable ou illisible : on garde la tuile, vide.
   Un pixel transparent évite l'icône d'image cassée du moteur de rendu. */
const IA_BLANK =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function iaNoThumb(img) {
  img.onerror = null;
  img.src = IA_BLANK;
}

function iaStatus(c) {
  if (c.saved) return `<span class="ia-badge done">✓ Enregistré dans Fichiers</span>`;
  return `<span class="ia-badge">○ En attente</span>`;
}

/* Conversations sous l'entrée IA de la barre latérale, comme les dossiers
   récents sous Fichiers ; la conversation ouverte y est sélectionnée. */
const IA_GLYPH = '<svg viewBox="0 0 24 24"><path d="M12 2.5 14 8l5.5 2-5.5 2-2 5.5L10 12 4.5 10 10 8zm6.5 10 1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/></svg>';
function iaRenderSide() {
  const box = $("side-ia");
  box.innerHTML = "";
  for (const c of IA.list) {
    const b = document.createElement("button");
    b.className = "side-item";
    b.dataset.conv = c.id;
    b.title = `d'après ${c.source_name}`;
    b.innerHTML = `<span class="glyph" style="color: #AF52DE">${IA_GLYPH}</span><span class="lbl">${esc(c.title)}</span>`;
    b.onclick = () => {
      switchView("ia");
      if (IA.open !== c.id) iaOpen(c.id);
    };
    b.oncontextmenu = (e) =>
      nativeMenu([
        { id: "ia:open:" + c.id, label: "Ouvrir la conversation" },
        { id: "ia:folder:" + c.id, label: "Afficher le dossier de travail" },
        {},
        { id: "ia:delete:" + c.id, label: "Supprimer" },
      ], e.clientX, e.clientY);
    box.appendChild(b);
  }
  sideSync();
}

function iaRender() {
  iaRenderSide();
  const detail = !!IA.open;
  $("ia-engine-tag").classList.toggle("hidden", detail);
  $("ia-dacts").classList.toggle("hidden", !detail);
  $("ia-back").classList.toggle("hidden", !detail);
  if (!detail) $("ia-engine-tag").textContent = iaEngineLabel();
  sideCount("ia", IA.list.length);
  const c = detail && IA.list.find((x) => x.id === IA.open);
  if (c) tbSet("ia", c.title, `d'après ${c.source_name} · ${c.engine === "container" ? "conteneur" : "local"}`);
  else tbSet("ia", "IA", IA.list.length ? `${IA.list.length} conversation${IA.list.length > 1 ? "s" : ""}` : "");
  $("ia-detail").classList.toggle("hidden", !detail);
  $("ia-empty").classList.toggle("hidden", detail || IA.list.length > 0);
  $("ia-list").classList.toggle("hidden", detail || IA.list.length === 0);
  if (detail) return;

  $("ia-list").innerHTML = IA.list
    .map((c) => {
      return `<article class="ia-card" data-id="${esc(c.id)}">
        <img class="ia-thumb" src="${esc(iaThumb(c))}" alt="" onerror="iaNoThumb(this)" />
        <div class="ia-body">
          <h3>${esc(c.title)}</h3>
          <div class="ia-sub">d'après ${esc(c.source_name)}</div>
          <div class="ia-meta">${esc(iaWhen(c.updated_at))} · v${c.version} · ${
            c.engine === "container" ? "conteneur" : "local"
          }</div>
          ${iaStatus(c)}
        </div>
        <button class="ia-del" data-act="ask" data-id="${esc(c.id)}" title="Supprimer">✕</button>
      </article>`;
    })
    .join("");
}

/* ------------------------------------------------------------ création */

/* Appelé depuis l'écran Fichiers. */
function iaStart(file) {
  if (!file || file.kind === "gcode") return;
  IA.source = file;
  $("ia-src").textContent = file.name;
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

async function iaCreate() {
  if (!IA.source) return;
  const btn = $("ia-go");
  btn.disabled = true;
  $("ia-msg").textContent = "Préparation de l'espace de travail…";
  $("ia-msg").className = "pf-test busy";
  try {
    const c = await invoke("ia_create", {
      source: IA.source.path,
      prompt: $("ia-prompt").value,
      engine: $("ia-engine").value,
    });
    closeSheet($("iamodal"));
    await iaRefresh();
    switchView("ia");
    toast("Conversation créée");
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
  if (await confirmDelete(`Supprimer « ${c.title} » ?`, "La conversation et son dossier de travail seront effacés.")) iaDelete(id);
}

async function iaDelete(id) {
  try {
    IA.list = await invoke("ia_delete", { id });
    // Le terminal a été fermé côté application : son émulateur n'a plus d'objet.
    const t = IA.terms.get(id);
    if (t) {
      t.term.dispose();
      IA.terms.delete(id);
    }
    if (IA.open === id) iaBack();
    iaRender();
    toast("Conversation supprimée");
  } catch (e) {
    toast(String(e), true);
  }
}

/* ------------------------------------------------------------ évènements */

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
    { id: "ia:open:" + card.dataset.id, label: "Ouvrir la conversation" },
    { id: "ia:folder:" + card.dataset.id, label: "Afficher le dossier de travail" },
    {},
    { id: "ia:delete:" + card.dataset.id, label: "Supprimer" },
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
$("ia-cancel").addEventListener("click", () => closeSheet($("iamodal")));

document.addEventListener("keydown", (e) => {
  if ($("iamodal").classList.contains("hidden")) return;
  if (e.key === "Escape") closeSheet($("iamodal"));
  // Entrée valide, sauf dans la zone de texte où elle sert à aller à la ligne.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); // sinon ⌘⏎ part aussi vers « Ajouter au plateau »
    iaCreate();
  }
});

/* ------------------------------------------------------------ terminal */

/* Un émulateur par conversation, gardé en mémoire tant que l'application vit.
   Changer d'onglet ou revenir à la liste ne doit rien effacer : on détache
   l'élément, on ne le détruit pas. */

/* Couleurs du terminal calées sur les jetons : fond --content-bg, texte --text,
   curseur à la couleur d'accent du système. */
function iaTheme() {
  // --accent peut valoir le mot-clé AccentColor : on lit la couleur résolue.
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

/* L'ajustement dépend de la taille réelle à l'écran : il faut que l'élément
   soit visible, donc après l'affichage. */
function iaFit(id) {
  const t = IA.terms.get(id);
  if (!t || !t.opened) return;
  try {
    t.fit.fit();
    invoke("pty_resize", { id, cols: t.term.cols, rows: t.term.rows }).catch(() => {});
  } catch {}
}

/* Dire à l'avance ce qui va se passer, plutôt que de laisser l'utilisateur
   devant une question en anglais ou devant un fil qui ne revient pas. */
async function iaHint(c) {
  const el = $("ia-hint");
  if (!c.started) {
    el.innerHTML =
      "Première ouverture : Claude vous demandera de confirmer le dossier de " +
      "travail. Répondez <b>« Yes, I trust this folder »</b> — c'est un dossier " +
      "que l'application vient de créer pour cette conversation.";
    el.classList.remove("hidden");
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
  el.innerHTML =
    "La conversation précédente n'a pas été retrouvée : Claude repart à neuf " +
    "dans le même dossier de travail. <b>L'objet et son historique de versions " +
    "sont intacts</b> — seul le fil de la discussion manque.";
  el.classList.remove("hidden");
}

async function iaOpen(id) {
  const c = IA.list.find((x) => x.id === id);
  if (!c) return;
  IA.open = id;
  iaRender();


  const host = $("ia-term");
  const t = iaTerm(id);
  host.innerHTML = "";
  host.appendChild(t.el);
  if (!t.opened) {
    t.term.open(t.el);
    t.opened = true;
  }
  $("ia-dead").classList.toggle("hidden", !t.dead);
  iaHint(c);

  // Le volet 3D et la surveillance du dossier vivent avec l'écran.
  iaQueue(() => iaLoadPane(id));

  // Une frame d'attente : xterm mesure la cellule sur l'élément affiché.
  requestAnimationFrame(async () => {
    iaFit(id);
    if (!t.dead) {
      if (c.engine === "container" && !t.greeted) {
        t.greeted = true;
        t.term.writeln(
          "\x1b[90mDémarrage du bac à sable… la première fois, l'image se " +
            "construit et cela peut prendre une minute.\x1b[0m"
        );
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

/* Le visualiseur est unique : il doit quitter le volet dès qu'on change
   d'onglet, sinon les fichiers ouverts ailleurs s'afficheraient dans une vue
   masquée — et reviendraient hanter la conversation. */
function iaSetVisible(on) {
  if (!IA.open) return;
  if (on) {
    iaDock();
    iaLoadPane(IA.open);
  } else {
    iaUndock();
  }
}

function iaBack() {
  iaUndock();
  IA.open = null;
  // L'élément retourne en réserve : l'historique du terminal est conservé.
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

/* Les octets arrivent en base64 : on les rend tels quels à l'émulateur, qui
   sait recoller un caractère coupé entre deux paquets. */
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

/* ------------------------------------------------------------ détail */

$("ia-back").addEventListener("click", iaBack);
$("ia-restart").addEventListener("click", iaRestart);

$("ia-stop").addEventListener("click", async () => {
  if (!IA.open) return;
  await invoke("pty_close", { id: IA.open });
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

/* ------------------------------------------------------------ volet 3D */

/* Le visualiseur n'est pas dupliqué : on déplace celui de l'application dans
   le volet. Même contexte graphique, même code, aucune divergence possible. */

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

/* Le volet est étroit : on doit pouvoir examiner la pièce en grand, comme
   depuis l'écran Fichiers. Le visualiseur quitte son cadre sans rien recharger,
   et Fermer — ou Échap — le remet à sa place. */
function iaExpand() {
  if (!IA.open || $("viewer").classList.contains("hidden")) return;
  iaUndock(false);
  if (typeof draw === "function") draw();
  V.onClose = () => {
    iaDock();
    if (typeof draw === "function") draw();
  };
}

const fmtMm = (x) => x.toFixed(1).replace(".", ",");

/* Masse estimée : le PLA pèse 1,24 g par centimètre cube. Sans maillage fermé,
   le volume ne veut rien dire, et on s'abstient. */
function iaRenderStats(s) {
  const rows = [["Dimensions", s.size.map(fmtMm).join(" × ") + " mm"]];
  if (s.watertight === true) {
    rows.push(["Masse estimée", `≈ ${Math.round(s.volume_cm3 * 1.24)} g de PLA`]);
  }
  rows.push([
    "Étanche",
    s.watertight === null ? "non vérifié" : s.watertight ? "oui" : "non",
  ]);
  rows.push(["Faces", s.triangles.toLocaleString("fr-FR")]);
  $("ia-stats").innerHTML = rows
    .map(
      ([k, v]) =>
        `<dt>${esc(k)}</dt><dd${k === "Étanche" && s.watertight === false ? ' class="warn"' : ""}>${esc(v)}</dd>`
    )
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
          title="${v.n === 1 ? "Objet d'origine" : "Revenir à cet état"}">v${v.n}</button>`
    )
    .join("");
}

/* Recharge l'objet affiché. Le numéro de version sert de brise-cache : sans
   lui, l'adresse ne changeant pas, l'ancien maillage serait resservi. */
async function iaShowCurrent(id) {
  try {
    const { path, stamp } = await invoke("ia_current", { id });
    const c = IA.list.find((x) => x.id === id);
    iaDock();
    await openViewer(path, c ? c.title : "", "3mf", stamp);
  } catch (e) {
    $("ia-stats").innerHTML = `<dt>Objet</dt><dd class="warn">${esc(String(e))}</dd>`;
  }
}

/* Les chargements du volet se suivent : deux écritures rapprochées de Claude
   lanceraient sinon deux lectures dont la plus ancienne peut finir la dernière,
   et l'objet affiché ne correspondrait plus aux mesures affichées à côté. */
let iaChain = Promise.resolve();
const iaQueue = (fn) => (iaChain = iaChain.then(fn).catch(() => {}));

async function iaLoadPane(id) {
  let version = 0;
  try {
    const c = await invoke("ia_get", { id });
    version = c.version;
  } catch {}
  await iaShowCurrent(id);
  await iaRenderVersions(id, version);
  try {
    iaRenderStats(await invoke("ia_stats", { id }));
  } catch {
    $("ia-stats").innerHTML = "";
  }
}

/* Claude vient d'écrire : l'objet change sous les yeux de l'utilisateur. */
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

$("ia-versions").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-v]");
  if (!btn || !IA.open) return;
  try {
    await invoke("ia_revert", { id: IA.open, n: +btn.dataset.v });
    await iaQueue(() => iaLoadPane(IA.open));
  } catch (e) {
    toast(String(e), true);
  }
});

const iaStageObserver = new ResizeObserver(() => {
  if (IA.open && typeof draw === "function") draw();
});
iaStageObserver.observe($("ia-stage"));

/* ------------------------------------------------------------ sortie */

/* Verse l'état courant dans vos fichiers et renvoie son chemin.
   Le 3MF rejoint le dossier de l'objet d'origine, sous un nom libre. */
async function iaSave(then) {
  if (!IA.open) return;
  const btns = [$("ia-save"), $("ia-slice")];
  btns.forEach((b) => (b.disabled = true));
  try {
    const path = await invoke("ia_save", { id: IA.open });
    const c = IA.list.find((x) => x.id === IA.open);
    if (c) c.saved = path;
    await refresh();
    toast("Enregistré : " + path.split("/").pop());
    if (then) await then(path);
  } catch (e) {
    toast(String(e), true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

$("ia-save").addEventListener("click", () => iaSave());

/* Découper enchaîne sur la fenêtre de découpe existante, le fichier fraîchement
   écrit étant devenu un fichier comme un autre. */
$("ia-slice").addEventListener("click", () =>
  iaSave(async (path) => {
    const f = state.files.find((x) => x.path === path);
    if (!f) {
      toast("Le fichier n'est pas dans le dossier affiché", true);
      return;
    }
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

// Conversations listées dès le lancement, dans la barre latérale.
iaRefresh();
