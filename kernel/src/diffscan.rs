//! diffscan.rs — the change ironguard judges, collected in one pass.
//!
//! `git diff -U0 <from>` parsed into added lines per file, plus every untracked
//! file read whole: a new file is the easiest place to add a key. The rules
//! stay in JavaScript (they need `{n}` counts and flags the `rx` subset does not
//! have); this op owns the part that scales with the change: the spawn, the
//! parse and the reads. Same output shape as `ironguard.collect` in JS, which is
//! the fallback and the contract `test/sentinel.test.js` pins.
use crate::json::Json;
use std::fs;
use std::path::Path;
use std::process::Command;

const BINARY_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz", "jar", "apk", "so", "dylib", "exe", "bin", "wasm", "dll"];

fn git(args: &[&str], cwd: &Path) -> (i32, Vec<u8>, String) {
    match Command::new("git").args(args).current_dir(cwd).output() {
        Ok(o) => (o.status.code().unwrap_or(1), o.stdout, String::from_utf8_lossy(&o.stderr).to_string()),
        Err(e) => (127, Vec::new(), e.to_string()),
    }
}

fn is_binary_name(p: &str) -> bool {
    Path::new(p).extension().and_then(|e| e.to_str()).map(|e| BINARY_EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

struct File { path: String, added: Vec<(usize, String)>, removed: usize, binary: bool }

fn to_json(f: &File) -> Json {
    let mut o = Json::obj();
    o.set("path", f.path.clone().into());
    o.set("added", Json::Arr(f.added.iter().map(|(n, t)| { let mut a = Json::obj(); a.set("line", (*n).into()); a.set("text", t.clone().into()); a }).collect()));
    o.set("removed", f.removed.into());
    o.set("binary", f.binary.into());
    o
}

/// The unified-diff parser, line for line with `parseDiff` in ironguard/index.js.
pub fn parse(text: &str) -> Vec<(String, Vec<(usize, String)>, usize, bool)> {
    let mut files: Vec<File> = Vec::new();
    let mut ln: usize = 0;
    for raw in text.split('\n') {
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            let p = rest.rfind(" b/").map(|i| rest[i + 3..].to_string()).unwrap_or_default();
            files.push(File { path: p, added: Vec::new(), removed: 0, binary: false });
            continue;
        }
        let Some(cur) = files.last_mut() else { continue };
        if let Some(p) = raw.strip_prefix("+++ ") { if p != "/dev/null" { cur.path = p.strip_prefix("b/").unwrap_or(p).to_string(); } continue; }
        if raw.starts_with("--- ") { continue; }
        if raw.starts_with("Binary files ") { cur.binary = true; continue; }
        if let Some(h) = raw.strip_prefix("@@ -") {
            if let Some(plus) = h.find(" +") {
                let n: String = h[plus + 2..].chars().take_while(|c| c.is_ascii_digit()).collect();
                ln = n.parse().unwrap_or(0);
            }
            continue;
        }
        if let Some(t) = raw.strip_prefix('+') { cur.added.push((ln, t.to_string())); ln += 1; }
        else if raw.starts_with('-') { cur.removed += 1; }
        else if raw.starts_with(' ') { ln += 1; }
    }
    files.into_iter().map(|f| (f.path, f.added, f.removed, f.binary)).collect()
}

pub fn op_diffscan(input: &Json) -> Json {
    let cwd = input.string("cwd", ".");
    let root = Path::new(&cwd);
    let from = input.string("from", "HEAD");
    let max = input.num("max_bytes", 2_000_000.0) as u64;
    let mut out = Json::obj();
    let (rc, stdout, err) = git(&["diff", "--no-color", "--no-ext-diff", "-U0", &from], root);
    if rc != 0 { out.set("ok", false.into()); out.set("why", format!("git diff {} failed: {}", from, err.trim()).into()); return out; }
    let text = String::from_utf8_lossy(&stdout);
    let mut files: Vec<File> = parse(&text).into_iter().map(|(path, added, removed, binary)| File { path, added, removed, binary }).collect();
    let (urc, un, _) = git(&["ls-files", "--others", "--exclude-standard", "-z"], root);
    if urc == 0 {
        for p in String::from_utf8_lossy(&un).split('\0').filter(|s| !s.is_empty()) {
            if is_binary_name(p) { files.push(File { path: p.to_string(), added: Vec::new(), removed: 0, binary: true }); continue; }
            let full = root.join(p);
            let Ok(meta) = fs::metadata(&full) else { continue };
            if !meta.is_file() || meta.len() > max { continue; }
            let Ok(bytes) = fs::read(&full) else { continue };
            if bytes.contains(&0u8) { files.push(File { path: p.to_string(), added: Vec::new(), removed: 0, binary: true }); continue; }
            let src = String::from_utf8_lossy(&bytes);
            let added = src.split('\n').enumerate().map(|(i, t)| (i + 1, t.to_string())).collect();
            files.push(File { path: p.to_string(), added, removed: 0, binary: false });
        }
    }
    out.set("ok", true.into());
    out.set("from", from.into());
    out.set("files", Json::Arr(files.iter().map(to_json).collect()));
    out
}
