//! `"<count>:<sha1 over (rel, mtime_ns, size)>"` — the one fingerprint. The
//! count prefix makes a glob that stopped matching visible instead of reading
//! as "nothing drifted". Mirrors `src/kit/cache.js` exactly.
use crate::json::Json;
use crate::sha1::sha1;
use std::fs;
use std::path::Path;

pub fn fingerprint(root: &Path, inputs: &[String]) -> (usize, String) {
    let mut rows: Vec<String> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for p in inputs {
        let path = Path::new(p);
        let md = match fs::metadata(path) { Ok(m) => m, Err(_) => continue };
        if !md.is_file() { continue; }
        let rel = path.strip_prefix(root).map(|r| r.to_string_lossy().to_string()).unwrap_or_else(|_| p.clone());
        let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        let r = rel.replace('\\', "/"); if seen.contains(&r) { continue; } seen.insert(r.clone()); rows.push(format!("{}:{}:{}", r, mtime, md.len()));
    }
    rows.sort();
    (rows.len(), sha1(rows.join("\n").as_bytes()))
}

pub fn op_fingerprint(input: &Json) -> Json {
    let root = std::path::PathBuf::from(input.string("root", "."));
    let (n, h) = fingerprint(&root, &input.str_list("inputs"));
    let mut out = Json::obj();
    out.set("fingerprint", format!("{}:{}", n, h).into());
    out.set("count", n.into());
    out
}
