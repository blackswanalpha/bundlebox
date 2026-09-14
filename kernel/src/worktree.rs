//! `git worktree add` plus seeding: a fresh worktree has tracked files only,
//! and every real gate needs gitignored ones (.env, generated clients). Copy,
//! never symlink; a missing source is reported, a failed copy fails the op.
use crate::json::Json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git(args: &[&str], cwd: &Path) -> (i32, String, String) {
    match Command::new("git").args(args).current_dir(cwd).output() {
        Ok(o) => (o.status.code().unwrap_or(1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string()),
        Err(e) => (127, String::new(), e.to_string()),
    }
}
fn copy_tree(src: &Path, dst: &Path) -> Result<usize, String> {
    if src.is_file() {
        if let Some(parent) = dst.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        fs::copy(src, dst).map_err(|e| format!("{}: {}", src.display(), e))?;
        return Ok(1);
    }
    let mut n = 0;
    for e in fs::read_dir(src).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        n += copy_tree(&e.path(), &dst.join(e.file_name()))?;
    }
    Ok(n)
}
pub fn op_worktree(input: &Json) -> Json {
    let repo = PathBuf::from(input.string("repo", "."));
    let path = PathBuf::from(input.string("path", ""));
    let branch = input.string("branch", "");
    let base = input.string("base", "");
    let apply = input.get("apply").and_then(|v| v.as_bool()).unwrap_or(false);
    let seeds = input.str_list("seed");
    let mut out = Json::obj(); let mut notes = Vec::new();
    if path.as_os_str().is_empty() || branch.is_empty() { out.set("ok", false.into()); out.set("why", "path and branch required".into()); return out; }
    let exists = path.join(".git").exists();
    out.set("existed", exists.into());
    if !exists {
        if !apply { out.set("ok", true.into()); out.set("would", format!("git worktree add -b {} {} {}", branch, path.display(), base).into()); }
        else {
            let mut args = vec!["worktree", "add", "-b", branch.as_str(), path.to_str().unwrap_or("")];
            if !base.is_empty() { args.push(base.as_str()); }
            let (rc, _, err) = git(&args, &repo);
            if rc != 0 && !base.is_empty() { let (rc2, _, err2) = git(&["worktree", "add", "-b", &branch, path.to_str().unwrap_or("")], &repo); if rc2 != 0 { out.set("ok", false.into()); out.set("why", format!("worktree add: {} / {}", err.trim(), err2.trim()).into()); return out; } notes.push(Json::from(format!("start point {} unavailable; branched from HEAD", base))); }
            else if rc != 0 { out.set("ok", false.into()); out.set("why", format!("worktree add: {}", err.trim()).into()); return out; }
        }
    }
    let mut copied = 0usize; let mut skipped = Vec::new(); let mut missing = Vec::new(); let mut stale = Vec::new();
    for s in seeds {
        let src = repo.join(&s); let dst = path.join(&s);
        if !src.exists() { missing.push(Json::from(s.clone())); continue; }
        if dst.exists() { stale.push(Json::from(s.clone())); continue; }
        if !apply { skipped.push(Json::from(s.clone())); continue; }
        match copy_tree(&src, &dst) { Ok(n) => copied += n, Err(e) => { out.set("ok", false.into()); out.set("why", format!("seed {}: {}", s, e).into()); return out; } }
    }
    out.set("ok", true.into()); out.set("path", path.to_string_lossy().to_string().into()); out.set("branch", branch.into());
    out.set("seeded", copied.into()); out.set("would_seed", Json::Arr(skipped)); out.set("seed_missing", Json::Arr(missing)); out.set("seed_stale", Json::Arr(stale));
    out.set("notes", Json::Arr(notes));
    out
}
pub fn op_worktree_prune(input: &Json) -> Json {
    let repo = PathBuf::from(input.string("repo", "."));
    let (rc, o, e) = git(&["worktree", "prune", "-v"], &repo);
    let mut out = Json::obj(); out.set("rc", (rc as i64).into()); out.set("output", format!("{}{}", o, e).trim().to_string().into()); out
}
