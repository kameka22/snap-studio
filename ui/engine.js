"use strict";
/* Moteur de découpe embarqué : état, téléchargement, progression.

   Un même bloc s'affiche à trois endroits — assistant de bienvenue, fenêtre
   de découpe, Réglages. Chaque endroit l'« accroche » à un conteneur ;
   l'installation et sa progression se reflètent partout à la fois. */

const ENG = {
  status: null,
  installing: false,
  progress: null,
  error: null,
  /* Conteneurs accrochés : élément → { onDone, settings } */
  mounts: new Map(),
};

async function engStatus() {
  ENG.status = await invoke("engine_status").catch(() => null);
  return ENG.status;
}

/* Un moteur est attendu mais pas encore là. */
const engNeeded = () => !!ENG.status?.referenced && ENG.status.available && !ENG.status.installed;
const fmtMo = (b) => `${Math.max(1, Math.round(b / 1e6))} Mo`;

/* Accroche le bloc à `box`. `onDone` : appelé une fois le moteur installé ;
   `settings` : variante des Réglages (Réinstaller, Supprimer, licence). */
function engMount(box, opts = {}) {
  ENG.mounts.set(box, opts);
  box.classList.add("eng");
  engPaint();
}

function engUnmount(box) {
  ENG.mounts.delete(box);
}

const ENG_PHASE = { download: "Téléchargement", verify: "Vérification de l'empreinte", extract: "Décompression", done: "Terminé" };

function engHtml(settings) {
  const s = ENG.status;
  if (!s) return `<div class="eng-text">État du moteur inconnu.</div>`;
  const name = `Snapmaker Orca ${esc(s.version)}`;
  if (!s.referenced) {
    return `<div class="eng-text"><b>Snapmaker Orca installé</b><small>Version de développement : le moteur de l'application installée sert à la découpe.</small></div>`;
  }
  if (!s.available) {
    return `<div class="eng-text"><b>Aucun moteur pour cette plateforme</b><small>La découpe n'est pas disponible ici.</small></div>`;
  }
  if (ENG.installing) {
    const p = ENG.progress || { phase: "download", done: 0, total: s.download_size };
    const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
    const detail = p.phase === "download" ? ` · ${fmtMo(p.done)} sur ${fmtMo(p.total)}` : "…";
    return `<div class="eng-text"><b>${ENG_PHASE[p.phase] || "Installation"}${detail}</b><small>Moteur ${name}</small></div>
      <div class="progress eng-bar"><i style="width:${Math.max(2, p.phase === "download" ? pct : 100)}%"></i></div>
      <div class="eng-actions">${p.phase === "download" ? '<button class="btn" data-eng="cancel">Annuler</button>' : ""}</div>`;
  }
  if (s.installed) {
    return `<div class="eng-text"><b>✓ Moteur ${name} installé</b><small>${fmtMo(s.disk_size)} sur le disque</small></div>
      ${
        settings
          ? `<div class="eng-actions"><button class="btn" data-eng="install">Réinstaller</button><button class="btn danger" data-eng="remove">Supprimer</button></div>`
          : ""
      }`;
  }
  // Un moteur plus ancien est là : c'est une mise à jour, pas une installation.
  const title = s.previous
    ? `Mise à jour du moteur de découpe : ${esc(s.previous)} → ${esc(s.version)}`
    : "Moteur de découpe à télécharger";
  return `<div class="eng-text"><b>${title}</b><small>${name} · ${fmtMo(s.download_size)} à télécharger, ${fmtMo(s.disk_size)} sur le disque</small>
      ${ENG.error ? `<small class="eng-err">${esc(ENG.error)}</small>` : ""}</div>
    <div class="eng-actions"><button class="btn primary" data-eng="install">${
      ENG.error ? "Réessayer" : s.previous ? "Mettre à jour" : "Télécharger"
    }</button></div>`;
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
        ? `<button class="w-link eng-source" data-eng="source">Licence AGPL-3.0 et code source</button>`
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
    toast(update ? `Moteur de découpe mis à jour (${ENG.status.version})` : "Moteur de découpe installé");
    for (const [, opts] of ENG.mounts) opts.onDone?.();
  } catch (e) {
    ENG.error = String(e);
    if (!silent) toast(`Moteur de découpe : ${e}`, true);
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
      "Supprimer le moteur de découpe ?",
      "Il faudra le télécharger de nouveau pour découper. Vos réglages et vos impressions sont conservés."
    );
    if (!ok) return;
    try {
      ENG.status = await invoke("engine_remove");
      toast("Moteur de découpe supprimé");
    } catch (err) {
      toast(String(err), true);
    }
    engPaint();
  }
});

/* État initial ; les Réglages l'affichent dès leur ouverture.

   Après une mise à jour de Snap Studio qui référence un nouveau moteur, il se
   télécharge tout de suite, en arrière-plan : il sera prêt au moment de
   découper. Une première installation, elle, reste à l'initiative de
   l'utilisateur (assistant, fenêtre de découpe, Réglages). Un échec reste
   silencieux ici : la fenêtre de découpe proposera « Réessayer ». */
engStatus().then(() => {
  engMount($("set-engine"), { settings: true });
  if (engNeeded() && ENG.status.previous) {
    setTimeout(() => engInstall({ silent: true }), 4000);
  }
});
