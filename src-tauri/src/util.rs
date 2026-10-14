/// Cleans an HTML description coming from slicers (MakerWorld double-encodes).
pub fn strip_html(input: &str) -> String {
    let mut s = input.to_string();
    for _ in 0..2 {
        s = s
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'");
    }
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let mut cleaned = String::new();
    for line in out.lines() {
        let l = line.trim();
        if !l.is_empty() {
            cleaned.push_str(l);
            cleaned.push('\n');
        }
    }
    cleaned.trim().to_string()
}

/// 64-bit FNV-1a hash, for cache keys.
pub fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in *p {
            h ^= *b as u64;
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// Looks for an executable, like `which`, without depending on the shell.
///
/// An app launched from the Finder does not inherit the terminal's `PATH`: so
/// the usual locations are added, otherwise `claude` or `docker` would stay
/// missing although they are installed.
pub fn which(name: &str) -> Option<std::path::PathBuf> {
    let extra = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ];
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(extra.iter().map(std::path::PathBuf::from));
    if let Some(h) = home {
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join("bin"));
    }
    // Windows: the command is written without its extension.
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    dirs.into_iter().find_map(|d| {
        names.iter().map(|n| d.join(n)).find(|c| c.is_file())
    })
}

/// Windows: runs the command without opening a console window.
pub fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Base64 encoding, without a dependency: the counterpart of `gcode.rs`'s
/// decoder.
///
/// Carries a terminal's raw bytes up to the UI, where only the emulator can
/// glue back a character split in two.
pub fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_the_reference() {
        for (raw, enc) in [
            ("", ""),
            ("a", "YQ=="),
            ("ab", "YWI="),
            ("abc", "YWJj"),
            ("bonjour, été", "Ym9uam91ciwgw6l0w6k="),
        ] {
            assert_eq!(super::b64_encode(raw.as_bytes()), enc, "for {raw:?}");
        }
    }
}
