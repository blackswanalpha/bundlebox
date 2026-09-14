//! Tree walk with the same ignore semantics as `src/core/fs.js`: names and
//! simple globs from the payload, hidden entries skipped (except .github),
//! symlinks never followed, files over `max_bytes` skipped. Iterative, so a
//! deep tree cannot overflow the stack, and never holding more than the
//! output list in memory.
use crate::json::Json;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Ignore { names: Vec<String>, globs: Vec<Glob> }
pub struct Glob { parts: Vec<String> }
impl Glob {
    fn new(g: &str) -> Glob { Glob { parts: g.split('*').map(|s| s.to_string()).collect() } }
    fn matches(&self, name: &str) -> bool {
        if self.parts.len() == 1 { return self.parts[0] == name; }
        let mut pos = 0usize;
        for (i, p) in self.parts.iter().enumerate() {
            if i == 0 { if !name.starts_with(p.as_str()) { return false; } pos = p.len(); continue; }
            if i == self.parts.len() - 1 { return name[pos..].ends_with(p.as_str()); }
            match name[pos..].find(p.as_str()) { Some(k) => pos += k + p.len(), None => return false }
        }
        true
    }
}
impl Ignore {
    pub fn from(list: &[String]) -> Ignore {
        let mut names = Vec::new(); let mut globs = Vec::new();
        for g in list { if g.contains('*') { globs.push(Glob::new(g)); } else { names.push(g.clone()); } }
        Ignore { names, globs }
    }
    pub fn hit(&self, name: &str) -> bool { self.names.iter().any(|n| n == name) || self.globs.iter().any(|g| g.matches(name)) }
}

pub fn walk(base: &Path, ignore: &Ignore, suffixes: &[String], max_bytes: u64, include_hidden: bool) -> Vec<(PathBuf, u64, u128)> {
    let mut out = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match fs::read_dir(&dir) { Ok(r) => r, Err(_) => continue };
        let mut ents: Vec<_> = rd.filter_map(|e| e.ok()).collect();
        ents.sort_by_key(|e| e.file_name());
        for e in ents {
            let name = e.file_name().to_string_lossy().to_string();
            if !include_hidden && name.starts_with('.') && name != ".github" { continue; }
            if ignore.hit(&name) { continue; }
            let ft = match e.file_type() { Ok(t) => t, Err(_) => continue };
            if ft.is_symlink() { continue; }
            let p = e.path();
            if ft.is_dir() { stack.push(p); continue; }
            if !ft.is_file() { continue; }
            if !suffixes.is_empty() && !suffixes.iter().any(|s| name.ends_with(s.as_str())) { continue; }
            let md = match fs::metadata(&p) { Ok(m) => m, Err(_) => continue };
            if md.len() > max_bytes { continue; }
            let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            out.push((p, md.len(), mtime));
        }
    }
    out.sort();
    out
}

pub fn op_walk(input: &Json) -> Json {
    let base = PathBuf::from(input.string("base", "."));
    let ignore = Ignore::from(&input.str_list("ignore"));
    let suffixes = input.str_list("suffixes");
    let max_bytes = input.num("max_bytes", 2_000_000.0) as u64;
    let hidden = input.get("include_hidden").and_then(|v| v.as_bool()).unwrap_or(false);
    let files = walk(&base, &ignore, &suffixes, max_bytes, hidden);
    let mut out = Json::obj();
    out.set("count", files.len().into());
    out.set("files", Json::Arr(files.iter().map(|(p, size, mtime)| { let mut o = Json::obj(); o.set("path", p.to_string_lossy().to_string().into()); o.set("size", (*size as f64).into()); o.set("mtime_ns", (*mtime as f64).into()); o }).collect()));
    out
}
