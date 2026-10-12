"use strict";
/* Mises à jour de l'application.

   Au lancement (si la case des Réglages est cochée) et sur demande — bouton
   des Réglages, menu Snap Studio —, le Rust interroge la dernière release
   GitHub. Nouvelle version : une fenêtre propose l'installation ; le paquet est
   téléchargé, sa signature vérifiée, puis l'application redémarre. */

const UP = {
  found: null,
  checking: false,
  installing: false,
  prefs: { auto: true, last: null, ...JSON.parse(localStorage.getItem("snapstudio.update") || "{}") },
};

const UP_RELEASES = "https://github.com/kameka22/snap-studio/releases/latest";

function upSave() {
  localStorage.setItem("snapstudio.update", JSON.stringify(UP.prefs));
}

function upStatus(text) {
  const when = UP.prefs.last ? ` · vérifié le ${dtf.format(new Date(UP.prefs.last))}` : "";
  $("up-status").textContent = (text || "Pas encore vérifié") + when;
}

/* `manual` : demandé par l'utilisateur, qui attend une réponse même si tout
   est à jour ; au lancement, on reste silencieux sauf nouvelle version. */
async function upCheck(manual) {
  if (UP.checking || UP.installing) return;
  UP.checking = true;
  $("up-check").disabled = true;
  $("up-status").textContent = "Recherche en cours…";
  try {
    const r = await invoke("update_check");
    UP.prefs.last = Date.now();
    upSave();
    UP.found = r;
    $("up-check").textContent = r ? "Afficher" : "Rechercher";
    if (r) {
      upStatus(`Version ${r.version} disponible`);
      upOpen();
    } else {
      upStatus("Snap Studio est à jour");
      if (manual) toast("Snap Studio est à jour");
    }
  } catch (e) {
    upStatus("Vérification impossible");
    if (manual) toast(`Vérification impossible : ${e}`, true);
  } finally {
    UP.checking = false;
    $("up-check").disabled = false;
  }
}

function upOpen() {
  const r = UP.found;
  if (!r) return;
  $("u-sub").textContent = `Snap Studio ${r.version} est disponible — vous avez la ${r.current}.`;
  $("u-notes").textContent = r.notes || "Pas de notes pour cette version.";
  $("u-progress").classList.add("hidden");
  $("u-msg").textContent = r.installable
    ? ""
    : "Cette installation ne peut pas se mettre à jour seule : téléchargez la nouvelle version sur GitHub.";
  $("u-go").textContent = r.installable ? "Installer et redémarrer" : "Ouvrir la page de téléchargement";
  $("u-go").disabled = false;
  $("u-later").disabled = false;
  openSheet($("umodal"));
}

/* Une découpe ou un envoi en cours serait perdu au redémarrage. */
const upBusy = () => Boolean(SL.job || SL.sending);

async function upInstall() {
  const r = UP.found;
  if (!r || UP.installing) return;
  if (!r.installable) {
    invoke("plugin:opener|open_url", { url: UP_RELEASES }).catch((e) => toast(String(e), true));
    closeSheet($("umodal"));
    return;
  }
  UP.installing = true;
  $("u-go").disabled = true;
  $("u-later").disabled = true;
  while (upBusy()) {
    $("u-msg").textContent = "Une découpe ou un envoi est en cours : l'installation commencera à sa fin.";
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  $("u-msg").textContent = "Téléchargement…";
  $("u-progress").classList.remove("hidden");
  $("u-progress").firstElementChild.style.width = "2%";
  try {
    // En cas de succès, l'application redémarre : cet appel ne revient pas.
    await invoke("update_install");
  } catch (e) {
    UP.installing = false;
    $("u-progress").classList.add("hidden");
    $("u-msg").textContent = `Installation impossible : ${e}`;
    $("u-go").disabled = false;
    $("u-later").disabled = false;
    // Le Rust a consommé la mise à jour : une nouvelle vérification la retrouve.
    UP.found = null;
    $("up-check").textContent = "Rechercher";
    upCheck(false);
  }
}

listen("update-progress", (e) => {
  const { done, total } = e.payload;
  if (!total) {
    $("u-msg").textContent = `Téléchargement… ${fmtSize(done)}`;
    return;
  }
  const pct = Math.min(100, (done / total) * 100);
  $("u-progress").firstElementChild.style.width = Math.max(2, pct) + "%";
  $("u-msg").textContent = pct >= 100 ? "Installation…" : `Téléchargement… ${fmtSize(done)} sur ${fmtSize(total)}`;
});

$("u-go").addEventListener("click", upInstall);
$("u-later").addEventListener("click", () => {
  if (!UP.installing) closeSheet($("umodal"));
});
$("umodal").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !UP.installing) closeSheet($("umodal"));
});
$("up-check").addEventListener("click", () => {
  // Une version déjà trouvée : rouvrir la fenêtre plutôt que réinterroger.
  if (UP.found) upOpen();
  else upCheck(true);
});
$("up-auto").addEventListener("change", () => {
  UP.prefs.auto = $("up-auto").checked;
  upSave();
});
onMenu("app", (what) => {
  if (what === "update") {
    if (UP.found) upOpen();
    else upCheck(true);
  }
});

(async () => {
  $("up-auto").checked = UP.prefs.auto;
  upStatus();
  $("up-version").textContent = await invoke("app_version").catch(() => "—");
  // Laisser l'application finir de démarrer avant d'interroger le réseau.
  // Pas de fenêtre de mise à jour par-dessus l'assistant de bienvenue.
  if (UP.prefs.auto) setTimeout(() => !W.open && upCheck(false), 3000);
})();
