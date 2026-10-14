"use strict";
/* Settings: a menu of categories on the left, one pane at a time on the
   right. Changing category slides the content vertically, in the menu's
   order: a category lower in the menu comes up from below, a higher one
   down from above. The last category comes back next time. */

const SET_KEY = "snapstudio.setcat";
const SET_CATS = [...document.querySelectorAll("#set-menu .set-cat")].map((b) => b.dataset.cat);
let setCurrent = null;

/* Shows a category; `animate` slides from the previous one. */
function setCategory(cat, animate = true) {
  if (!SET_CATS.includes(cat)) cat = SET_CATS[0];
  const prev = setCurrent;
  setCurrent = cat;
  localStorage.setItem(SET_KEY, cat);
  document.querySelectorAll("#set-menu .set-cat").forEach((b) => b.classList.toggle("on", b.dataset.cat === cat));
  const panes = document.querySelectorAll("#set-stage .set-pane");
  const next = document.querySelector(`#set-stage .set-pane[data-cat="${cat}"]`);
  const old = prev && prev !== cat ? document.querySelector(`#set-stage .set-pane[data-cat="${prev}"]`) : null;
  panes.forEach((p) => {
    const keep = p === next || p === old;
    if (!keep) p.getAnimations().forEach((a) => a.cancel());
    p.classList.toggle("on", keep);
  });
  next.getAnimations().forEach((a) => a.cancel());
  tbSet("settings", tr("nav.settings"), tr(next.querySelector(".set-title").dataset.i18n));
  if (cat === "ai") setAiRender();
  if (cat === "about") aboutLoad();
  if (!old) {
    panes.forEach((p) => p.classList.toggle("on", p === next));
    return;
  }
  const still = !animate || matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still) {
    old.classList.remove("on");
    return;
  }
  // Down the menu: the content moves up; up the menu: it moves down.
  const dir = SET_CATS.indexOf(cat) > SET_CATS.indexOf(prev) ? 1 : -1;
  const h = $("set-stage").clientHeight * 0.35;
  const opts = { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
  next.scrollTop = 0;
  next.animate([{ transform: `translateY(${dir * h}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], opts);
  old.animate([{ transform: "none", opacity: 1 }, { transform: `translateY(${-dir * h}px)`, opacity: 0 }], { ...opts, fill: "forwards" });
  // The leaving pane goes once its slide is over — or at once if another
  // change comes first.
  clearTimeout(setLeave);
  setLeave = setTimeout(() => {
    old.getAnimations().forEach((a) => a.cancel());
    if (setCurrent !== prev) old.classList.remove("on");
  }, opts.duration);
}
let setLeave = 0;

$("set-menu").addEventListener("click", (e) => {
  const b = e.target.closest(".set-cat");
  if (b && b.dataset.cat !== setCurrent) setCategory(b.dataset.cat);
});

/* Arrow keys move through the menu when it has the focus. */
$("set-menu").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const i = SET_CATS.indexOf(setCurrent) + (e.key === "ArrowDown" ? 1 : -1);
  if (i >= 0 && i < SET_CATS.length) {
    setCategory(SET_CATS[i]);
    document.querySelector(`#set-menu .set-cat[data-cat="${SET_CATS[i]}"]`).focus();
  }
});

/* Opening Settings: the category that needs attention, otherwise the last
   one seen. */
function settingsShown() {
  const flagged = document.querySelector("#set-menu .set-cat.flag");
  setCategory(flagged ? flagged.dataset.cat : localStorage.getItem(SET_KEY) || SET_CATS[0], false);
}

/* ------------------------------------------------------------ AI */

function setAiRender() {
  $("set-ai-mode").value = aiChoice();
  aiRenderChecks($("set-ai-checks"), aiChoice());
}

/* The AI's dot: a chosen mode is not ready. */
function setAiFlag() {
  const r = AIS.report;
  const flag = !!r && aiWanted().some((m) => !r.ready[m]);
  document.querySelector('#set-menu .set-cat[data-cat="ai"]').classList.toggle("flag", flag);
}

$("set-ai-mode").addEventListener("change", (e) => aiSetChoice(e.target.value));
$("set-ai-recheck").addEventListener("click", () => {
  aiCheck(true);
  setAiRender();
});

window.addEventListener("aichange", () => {
  setAiFlag();
  if (setCurrent === "ai") setAiRender();
});

window.addEventListener("langchange", () => {
  if (setCurrent) tbSet("settings", tr("nav.settings"), tr(`${document.querySelector(`#set-stage .set-pane[data-cat="${setCurrent}"] .set-title`).dataset.i18n}`));
  if (setCurrent === "ai") setAiRender();
});

/* ------------------------------------------------------------ about */

const REPO = "https://github.com/kameka22/snap-studio";
const ABOUT = { version: "", system: "" };

async function aboutLoad() {
  if (!ABOUT.version) {
    [ABOUT.version, ABOUT.system] = await Promise.all([
      invoke("app_version").catch(() => ""),
      invoke("system_name").catch(() => ""),
    ]);
  }
  $("about-version").textContent = tr("about.version", { version: ABOUT.version, system: ABOUT.system });
}

/* What a bug report needs beyond the version and the system. */
function aboutDetails() {
  const engine = typeof ENG !== "undefined" && ENG.status?.installed ? `Snapmaker Orca ${ENG.status.version}` : "—";
  const ai = AIS.report ? aiAllowed().join(", ") || "not ready" : "not checked";
  return [`Language: ${LANG}`, `Slicing engine: ${engine}`, `AI: ${aiChoice()} (ready: ${ai})`].join("\n");
}

/* Opens a page of the project; a bug report comes prefilled. */
async function aboutOpen(what) {
  await aboutLoad();
  const q = (o) => new URLSearchParams(o).toString();
  const url = {
    bug: `${REPO}/issues/new?${q({ template: "bug.yml", version: ABOUT.version, os: ABOUT.system, details: aboutDetails() })}`,
    idea: `${REPO}/issues/new?${q({ template: "feature.yml", version: ABOUT.version })}`,
    contribute: `${REPO}/blob/main/${LANG === "fr" ? "CONTRIBUTING.fr.md" : "CONTRIBUTING.md"}`,
    discuss: `${REPO}/discussions`,
    github: REPO,
    issues: `${REPO}/issues`,
    licenses: `${REPO}/blob/main/ui/vendor/NOTICE.md`,
  }[what];
  if (url) invoke("plugin:opener|open_url", { url }).catch((e) => toast(String(e), true));
}

document.querySelector('#set-stage .set-pane[data-cat="about"]').addEventListener("click", (e) => {
  const b = e.target.closest("[data-about]");
  if (b) aboutOpen(b.dataset.about);
});

/* Help menu: report, suggest, the project. */
onMenu("help", (what) => aboutOpen(what));
