//! Les terminaux des conversations IA.
//!
//! On n'imite pas Claude Code : on le fait tourner pour de bon, dans un
//! pseudo-terminal. L'interface en affiche la sortie telle quelle, et lui
//! renvoie les frappes. Tout ce que sait faire l'outil — mode plan, commandes
//! slash, `@fichier`, interruption — fonctionne donc sans rien coder.
//!
//! Les octets remontent en base64 : découpés à la lecture, ils peuvent trancher
//! un caractère accentué en deux, et seul l'émulateur côté interface sait
//! recoller les morceaux.

use crate::ia::Conversation;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Chunk {
    id: String,
    b64: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: String,
    code: i32,
}

struct Session {
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// Le canal d'écriture a son propre verrou : écrire peut bloquer si le
    /// terminal ne consomme pas, et cela ne doit pas figer tout le reste.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Les exécutables trouvés sur la machine.
pub struct Tools {
    pub claude: Option<PathBuf>,
    pub yolobox: Option<PathBuf>,
}

impl Tools {
    pub fn detect() -> Tools {
        Tools {
            claude: crate::util::which("claude"),
            yolobox: crate::util::which("yolobox"),
        }
    }
}

/// La ligne de commande qui ouvre la conversation.
///
/// L'identifiant de la conversation est aussi celui de la session Claude :
/// `--session-id` à la première ouverture, `--resume` ensuite. C'est ce qui
/// rend la reprise fiable sans jamais fouiller l'historique de Claude.
///
/// La forme du mode conteneur a été établie contre yolobox v0.19.4 : ses
/// drapeaux suivent la sous-commande, et il transmet à Claude tout ce qu'il ne
/// reconnaît pas — un séparateur `--` lui ferait avaler le reste.
pub fn command_line(c: &Conversation, tools: &Tools, resume: bool) -> Result<Vec<String>> {
    let claude = tools
        .claude
        .as_ref()
        .ok_or_else(|| anyhow!("Claude Code est introuvable sur cette machine"))?;

    let mut inner: Vec<String> = Vec::new();
    if resume {
        inner.push("--resume".into());
        inner.push(c.id.clone());
    } else {
        inner.push("--session-id".into());
        inner.push(c.id.clone());
    }

    if c.engine == "container" {
        let yolobox = tools
            .yolobox
            .as_ref()
            .ok_or_else(|| anyhow!("yolobox est introuvable ; essayez le mode local"))?;
        if !resume && !c.prompt.is_empty() {
            inner.push(c.prompt.clone());
        }
        // Les drapeaux de yolobox se placent après la sous-commande, et tout ce
        // qu'il ne reconnaît pas file à Claude — donc pas de séparateur.
        //
        // On ne demande pas les pleins pouvoirs ici : le bac à sable les
        // accorde déjà de lui-même, et l'option déclencherait en plus son
        // propre écran d'acceptation.
        //
        // `--claude-config` partage la configuration et, surtout, monte le
        // dossier des sessions : c'est ce qui rend la reprise possible depuis
        // l'hôte.
        let mut argv = vec![
            yolobox.to_string_lossy().to_string(),
            "claude".into(),
            "--claude-config".into(),
            "--customize-file".into(),
            crate::ia::dockerfile().to_string_lossy().to_string(),
        ];
        argv.extend(inner);
        return Ok(argv);
    }

    // En local, Claude travaille sur votre Mac : les modifications de fichiers
    // sont acceptées d'office, les commandes restent soumises à votre accord.
    inner.push("--permission-mode".into());
    inner.push("acceptEdits".into());
    if !resume && !c.prompt.is_empty() {
        inner.push(c.prompt.clone());
    }
    let mut argv = vec![claude.to_string_lossy().to_string()];
    argv.extend(inner);
    Ok(argv)
}

/// Retire de l'environnement les marqueurs de session héritée.
///
/// Une application lancée depuis un terminal Claude Code en hérite, et Claude
/// Code, en les voyant, **cesse d'enregistrer la conversation** : il n'y a alors
/// plus rien à reprendre la fois suivante. On ne garde que `CLAUDE_CONFIG_DIR`,
/// qui est un réglage délibéré de l'utilisateur, et l'on ne touche à rien
/// d'autre — surtout pas aux identifiants d'API.
fn purge_markers(cmd: &mut CommandBuilder, names: impl Iterator<Item = String>) {
    for k in names {
        if k.starts_with("CLAUDE") && k != "CLAUDE_CONFIG_DIR" {
            cmd.env_remove(&k);
        }
    }
}

/// Vrai si un terminal tourne déjà pour cette conversation.
pub fn is_open(id: &str) -> bool {
    sessions().lock().map(|s| s.contains_key(id)).unwrap_or(false)
}

/// Ouvre le terminal d'une conversation, ou ne fait rien s'il tourne déjà.
pub fn open(app: &AppHandle, c: &Conversation, cols: u16, rows: u16) -> Result<()> {
    // Deux demandes simultanées lanceraient deux Claude sur la même session :
    // les ouvertures se font une à une.
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _gate = GATE.get_or_init(|| Mutex::new(())).lock().unwrap();
    if is_open(&c.id) {
        return Ok(());
    }
    let ws = crate::ia::workspace(&c.id);
    if !ws.is_dir() {
        return Err(anyhow!("dossier de travail introuvable"));
    }

    // Consignes, outils et aperçus remis à niveau avant que Claude ne les lise.
    crate::ia::refresh_workspace(&c.id);

    let tools = Tools::detect();
    // La vérité est sur le disque, pas dans notre fiche : une session ne
    // se reprend que si Claude en a écrit une.
    let argv = command_line(c, &tools, crate::ia::has_session(&c.id))?;

    let pair = native_pty_system().openpty(PtySize {
        rows: rows.max(4),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = CommandBuilder::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    cmd.cwd(&ws);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Lancée depuis le Finder, l'application n'hérite pas du `PATH` du
    // terminal : on le complète pour que Claude retrouve ses outils.
    let mut path: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(unix) {
        path.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(Into::into));
    }
    if let Ok(p) = std::env::join_paths(path) {
        cmd.env("PATH", p);
    }

    purge_markers(&mut cmd, std::env::vars().map(|(k, _)| k));

    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;

    sessions().lock().unwrap().insert(
        c.id.clone(),
        Session {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
        },
    );

    // Le dossier est surveillé tant que le terminal vit — et non tant que
    // l'écran est affiché : ce que Claude écrit pendant qu'on regarde ailleurs
    // doit être archivé quand même.
    let _ = crate::ia::watch_start(app.clone(), &c.id);

    // Une fois lancée, la session existe pour Claude : la prochaine ouverture
    // devra la reprendre plutôt que la créer.
    crate::ia::mark_started(&c.id);

    let id = c.id.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit(
                        "ia-pty",
                        Chunk {
                            id: id.clone(),
                            b64: crate::util::b64_encode(&buf[..n]),
                        },
                    );
                }
            }
        }
        let code = close_and_wait(&id);
        let _ = app.emit("ia-exit", Exit { id, code });
    });

    Ok(())
}

pub fn write(id: &str, data: &str) -> Result<()> {
    // On récupère le canal, puis on relâche le verrou général avant d'écrire :
    // un collage volumineux peut bloquer plusieurs secondes.
    let w = {
        let s = sessions().lock().unwrap();
        s.get(id).ok_or_else(|| anyhow!("terminal fermé"))?.writer.clone()
    };
    let mut w = w.lock().unwrap();
    w.write_all(data.as_bytes())?;
    w.flush()?;
    Ok(())
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<()> {
    let s = sessions().lock().unwrap();
    let sess = s.get(id).ok_or_else(|| anyhow!("terminal fermé"))?;
    sess.master.resize(PtySize {
        rows: rows.max(4),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })?;
    Ok(())
}

/// Délai laissé à Claude pour se retirer de lui-même.
const GRACE: std::time::Duration = std::time::Duration::from_millis(2500);

/// Retire la session et attend la fin du processus.
///
/// On demande d'abord poliment. Un outil interactif a du ménage à faire en
/// partant — ne serait-ce qu'écrire sa conversation sur le disque — et le tuer
/// net le lui interdit. La manière forte reste, mais en dernier recours.
fn close_and_wait(id: &str) -> i32 {
    crate::ia::watch_stop(id);
    let Some(mut sess) = sessions().lock().unwrap().remove(id) else {
        return 0;
    };

    // Échap referme une éventuelle boîte de dialogue, puis deux interruptions
    // rapprochées font sortir Claude Code.
    if let Ok(mut w) = sess.writer.lock() {
        let _ = w.write_all(b"\x1b");
        let _ = w.flush();
        let _ = w.write_all(b"\x03\x03");
        let _ = w.flush();
    }

    let deadline = std::time::Instant::now() + GRACE;
    let mut code = None;
    while std::time::Instant::now() < deadline {
        match sess.child.try_wait() {
            Ok(Some(st)) => {
                code = Some(st.exit_code() as i32);
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(80)),
            Err(_) => break,
        }
    }

    code.unwrap_or_else(|| {
        let _ = sess.child.kill();
        sess.child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1)
    })
}

pub fn close(id: &str) {
    close_and_wait(id);
}

/// Ferme tous les terminaux — à la fermeture de l'application.
pub fn close_all() {
    let ids: Vec<String> = sessions()
        .lock()
        .map(|s| s.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        close_and_wait(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(engine: &str, prompt: &str, started: bool) -> Conversation {
        Conversation {
            id: "11111111-2222-3333-4444-555555555555".into(),
            title: "Essai".into(),
            source: "/tmp/x.3mf".into(),
            source_name: "x.3mf".into(),
            prompt: prompt.into(),
            engine: engine.into(),
            created_at: 0,
            updated_at: 0,
            version: 1,
            saved: None,
            started,
            kind: String::new(),
            dest_dir: None,
            bounds: None,
        }
    }

    fn tools() -> Tools {
        Tools {
            claude: Some(PathBuf::from("/usr/local/bin/claude")),
            yolobox: Some(PathBuf::from("/opt/homebrew/bin/yolobox")),
        }
    }

    #[test]
    fn first_run_creates_the_session() {
        let c = conv("local", "Incline de 15°", false);
        let argv = command_line(&c, &tools(), false).unwrap();
        assert_eq!(argv[0], "/usr/local/bin/claude");
        assert!(argv.contains(&"--session-id".to_string()));
        assert!(argv.contains(&c.id));
        assert!(!argv.contains(&"--resume".to_string()));
        assert_eq!(argv.last().unwrap(), "Incline de 15°", "la demande est passée telle quelle");
    }

    #[test]
    fn reopening_resumes_it() {
        let c = conv("local", "Incline de 15°", true);
        let argv = command_line(&c, &tools(), true).unwrap();
        assert!(argv.contains(&"--resume".to_string()));
        assert!(!argv.contains(&"--session-id".to_string()));
        assert!(
            !argv.contains(&"Incline de 15°".to_string()),
            "la demande initiale ne doit pas être renvoyée à la reprise"
        );
    }

    /// La forme exacte a été vérifiée contre le vrai yolobox : ses drapeaux
    /// suivent la sous-commande, il transmet à Claude ce qu'il ne reconnaît
    /// pas, et un séparateur `--` lui ferait avaler le reste.
    #[test]
    fn container_wraps_the_command() {
        let c = conv("container", "Creuse la base", false);
        let argv = command_line(&c, &tools(), false).unwrap();
        assert_eq!(argv[0], "/opt/homebrew/bin/yolobox");
        assert_eq!(argv[1], "claude", "la sous-commande vient en premier");
        assert!(!argv.iter().any(|a| a == "--"), "aucun séparateur");
        assert!(
            !argv.iter().any(|a| a == "--dangerously-skip-permissions"),
            "le bac à sable s'en charge, et l'option ouvrirait un dialogue"
        );

        let cfg = argv.iter().position(|a| a == "--claude-config").unwrap();
        let sid = argv.iter().position(|a| a == "--session-id").unwrap();
        assert!(cfg < sid, "les drapeaux du bac à sable précèdent ceux de Claude");
        assert_eq!(argv.last().unwrap(), "Creuse la base");
    }

    #[test]
    fn missing_tools_are_reported() {
        let none = Tools {
            claude: None,
            yolobox: None,
        };
        let err = command_line(&conv("local", "", false), &none, false).unwrap_err();
        assert!(err.to_string().contains("Claude Code"));

        let no_box = Tools {
            claude: Some(PathBuf::from("/usr/local/bin/claude")),
            yolobox: None,
        };
        let err = command_line(&conv("container", "", false), &no_box, false).unwrap_err();
        assert!(err.to_string().contains("yolobox"));
    }

    /// Un terminal sur une commande banale : on écrit, on relit.
    #[test]
    fn a_terminal_carries_bytes_both_ways() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/cat");
        cmd.env("TERM", "dumb");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"bonjour\n").unwrap();
        writer.flush().unwrap();

        let mut seen = String::new();
        let mut buf = [0u8; 256];
        for _ in 0..20 {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    seen.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if seen.contains("bonjour") {
                        break;
                    }
                }
            }
        }
        let _ = child.kill();
        assert!(seen.contains("bonjour"), "lu : {seen:?}");
    }
}

#[cfg(test)]
mod essai_reel {
    use super::*;
    use std::time::{Duration, Instant};

    /// Lance vraiment Claude Code dans un pseudo-terminal et regarde ce qui
    /// en sort. Sans demande initiale, rien n'est envoyé au modèle : on
    /// vérifie seulement que l'outil démarre au bon endroit.
    ///
    /// `IA_PTY=/chemin/objet.3mf cargo test essai_reel -- --nocapture`
    #[test]
    fn claude_starts_in_the_workspace() {
        let Ok(src) = std::env::var("IA_PTY") else {
            return;
        };
        let c = crate::ia::create(std::path::Path::new(&src), "", "local").unwrap();
        // Consignes, outils et aperçus remis à niveau avant que Claude ne les lise.
    crate::ia::refresh_workspace(&c.id);

    let tools = Tools::detect();
        let argv = command_line(&c, &tools, false).unwrap();
        println!("commande : {argv:?}");

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 30,
                cols: 100,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new(&argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        cmd.cwd(crate::ia::workspace(&c.id));
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let mut seen = Vec::new();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(12) {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
                seen.extend_from_slice(&chunk);
            }
            let text = String::from_utf8_lossy(&seen);
            if text.contains("bypass") || text.contains("?") && seen.len() > 2000 {
                break;
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&seen);
        println!("--- {} octets reçus ---", seen.len());
        println!("{}", text.chars().take(1500).collect::<String>());
        assert!(seen.len() > 200, "Claude n'a rien affiché");
        assert!(
            seen.contains(&0x1b),
            "aucune séquence d'échappement : ce n'est pas une interface de terminal"
        );
        crate::ia::remove(&c.id).unwrap();
    }
}

#[cfg(test)]
mod env_tests {
    /// Les marqueurs de session héritée doivent disparaître de l'environnement
    /// transmis à Claude Code.
    ///
    /// C'est la cause exacte des conversations irrécupérables : voyant
    /// `CLAUDE_CODE_CHILD_SESSION`, Claude affiche « Transcript saving is off »
    /// et n'écrit aucune session — `--resume` comme `/resume` ne trouvent alors
    /// plus rien.
    #[test]
    fn inherited_markers_are_dropped() {
        use super::*;
        let planted = [
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_CHILD_SESSION", "oui"),
            ("CLAUDE_CODE_SESSION_ID", "abc"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_PID", "123"),
            ("CLAUDE_CONFIG_DIR", "/tmp/conf"),
            ("ANTHROPIC_API_KEY", "secret"),
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/x"),
        ];
        let mut cmd = CommandBuilder::new("/bin/echo");
        for (k, v) in planted {
            cmd.env(k, v);
        }
        purge_markers(&mut cmd, planted.iter().map(|(k, _)| k.to_string()));

        let left: std::collections::HashMap<&str, &str> =
            cmd.iter_full_env_as_str().collect();
        for k in [
            "CLAUDECODE",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_PID",
        ] {
            assert!(!left.contains_key(k), "« {k} » aurait dû disparaître");
        }
        assert_eq!(left.get("CLAUDE_CONFIG_DIR"), Some(&"/tmp/conf"), "réglage voulu");
        assert_eq!(left.get("ANTHROPIC_API_KEY"), Some(&"secret"), "on n'y touche pas");
        assert_eq!(left.get("PATH"), Some(&"/usr/bin"));
        assert_eq!(left.get("HOME"), Some(&"/Users/x"));
    }
}
