//! Top-level declaration index: `name  file:line` per language, plus `anchor`
//! (locate one symbol's region by brace or indent matching). The regexes the
//! JS side uses are reproduced as hand-written matchers here because the
//! kernel has no regex crate; the selftest pins both sides to the same answers
//! on this package's own source.
use crate::json::Json;
use std::fs;

fn ident_at(s: &[u8], mut i: usize) -> Option<(String, usize)> {
    while i < s.len() && (s[i] == b' ' || s[i] == b'\t') { i += 1; }
    let st = i;
    while i < s.len() && (s[i].is_ascii_alphanumeric() || s[i] == b'_' || s[i] == b'$') { i += 1; }
    if i == st { None } else { Some((String::from_utf8_lossy(&s[st..i]).to_string(), i)) }
}
fn after_kw(line: &str, kws: &[&str]) -> Option<String> {
    let b = line.as_bytes();
    for kw in kws {
        if let Some(pos) = line.find(kw) {
            let before = &line[..pos];
            if !before.trim().is_empty() && !before.trim().ends_with("export") && !before.trim().ends_with("default") && !before.trim().ends_with("async") && !before.trim().ends_with("pub") && !before.trim().ends_with("pub(crate)") { continue; }
            // `kw` carries its own trailing space, so the identifier starts at `end`.
            if let Some((name, _)) = ident_at(b, pos + kw.len()) { return Some(name); }
        }
    }
    None
}
/// Declaration name on this line, if it opens a top-level declaration.
pub fn decl(line: &str, lang: &str) -> Option<String> {
    let t = line.trim_start();
    if t.is_empty() || t.starts_with("//") || t.starts_with('#') && lang != "py" || t.starts_with('*') { return None; }
    let indented = line.len() != t.len();
    match lang {
        "py" => { if indented { return None; } after_kw(t, &["def ", "class ", "async def "]) }
        "js" | "ts" => {
            if indented { return None; }
            if let Some(n) = after_kw(t, &["function ", "class ", "async function ", "function* "]) { return Some(n); }
            if let Some(n) = after_kw(t, &["const ", "let ", "var "]) { if t.contains('=') { return Some(n); } }
            if t.starts_with("export default function") { return Some("default".into()); }
            None
        }
        "go" => { if let Some(n) = after_kw(t, &["func ", "type "]) { if t.starts_with("func (") { return t.split(')').nth(1).and_then(|r| ident_at(r.as_bytes(), 0)).map(|(n, _)| n); } return Some(n); } None }
        "rust" => after_kw(t, &["fn ", "struct ", "enum ", "trait ", "impl ", "mod ", "const ", "static ", "type "]),
        "dart" | "java" | "kotlin" | "swift" | "csharp" => { if indented && lang != "dart" { return None; } after_kw(t, &["class ", "enum ", "fun ", "func ", "interface ", "mixin ", "extension ", "void ", "Future<void> ", "record ", "struct ", "protocol "]) }
        "ruby" => after_kw(t, &["def ", "class ", "module "]),
        "php" => after_kw(t, &["function ", "class ", "interface ", "trait "]),
        "md" => { if t.starts_with('#') { Some(t.trim_start_matches('#').trim().to_string()) } else { None } }
        _ => None,
    }
}
pub fn lang_of(p: &str) -> &'static str {
    let ext = p.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() { "js" | "mjs" | "cjs" | "jsx" => "js", "ts" | "tsx" => "ts", "py" => "py", "go" => "go", "rs" => "rust", "dart" => "dart", "java" => "java", "kt" | "kts" => "kotlin", "swift" => "swift", "cs" => "csharp", "rb" => "ruby", "php" => "php", "md" | "markdown" => "md", _ => "other" }
}
pub fn op_symbols(input: &Json) -> Json {
    let mut rows = Vec::new(); let mut n = 0usize;
    for p in input.str_list("paths") {
        let lang = lang_of(&p);
        if lang == "other" { continue; }
        let text = match fs::read(&p) { Ok(b) => String::from_utf8_lossy(&b).to_string(), Err(_) => continue };
        for (i, line) in text.lines().enumerate() {
            if let Some(name) = decl(line, lang) { let mut o = Json::obj(); o.set("name", name.into()); o.set("file", p.clone().into()); o.set("line", (i + 1).into()); rows.push(o); n += 1; }
        }
    }
    let mut out = Json::obj(); out.set("count", n.into()); out.set("symbols", Json::Arr(rows)); out
}
/// Locate `symbol` in `path`: line range by brace matching (skipping strings and
/// comments) or by indentation for Python. Returns null when not found — never a guess.
pub fn op_anchor(input: &Json) -> Json {
    let p = input.string("path", ""); let symbol = input.string("symbol", "");
    let lang = lang_of(&p);
    let text = match fs::read(&p) { Ok(b) => String::from_utf8_lossy(&b).to_string(), Err(_) => return Json::Null };
    let lines: Vec<&str> = text.lines().collect();
    let start = match lines.iter().position(|l| decl(l, lang).as_deref() == Some(symbol.as_str())) { Some(i) => i, None => return Json::Null };
    let end = if lang == "py" || lang == "md" {
        let base_indent = if lang == "md" { lines[start].chars().take_while(|c| *c == '#').count() } else { lines[start].len() - lines[start].trim_start().len() };
        let mut e = start;
        for (i, l) in lines.iter().enumerate().skip(start + 1) {
            if l.trim().is_empty() { continue; }
            let ind = if lang == "md" { if l.starts_with('#') { l.chars().take_while(|c| *c == '#').count() } else { usize::MAX } } else { l.len() - l.trim_start().len() };
            if ind <= base_indent { break; }
            e = i;
        }
        e
    } else {
        let mut depth = 0i32; let mut opened = false; let mut e = start;
        let mut in_str: Option<char> = None; let mut in_block = false;
        'outer: for (i, l) in lines.iter().enumerate().skip(start) {
            let cs: Vec<char> = l.chars().collect(); let mut j = 0;
            while j < cs.len() {
                let c = cs[j];
                if in_block { if c == '*' && j + 1 < cs.len() && cs[j + 1] == '/' { in_block = false; j += 1; } j += 1; continue; }
                if let Some(q) = in_str { if c == '\\' { j += 2; continue; } if c == q { in_str = None; } j += 1; continue; }
                if c == '/' && j + 1 < cs.len() && cs[j + 1] == '/' { break; }
                if c == '/' && j + 1 < cs.len() && cs[j + 1] == '*' { in_block = true; j += 2; continue; }
                if c == '"' || c == '\'' || c == '`' { in_str = Some(c); j += 1; continue; }
                if c == '{' { depth += 1; opened = true; }
                if c == '}' { depth -= 1; if opened && depth == 0 { e = i; break 'outer; } }
                j += 1;
            }
            if !opened && l.trim_end().ends_with(';') { e = i; break; }
            e = i;
        }
        e
    };
    let mut out = Json::obj();
    out.set("path", p.into()); out.set("symbol", symbol.into()); out.set("line_start", (start + 1).into()); out.set("line_end", (end + 1).into());
    out.set("text", lines[start..=end].join("\n").into());
    out
}
