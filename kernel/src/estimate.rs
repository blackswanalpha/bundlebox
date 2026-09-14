//! tokens ~= w*words + p*punct + s*indent_runs — the same three counts as
//! `src/tokens/estimate.js`, so both sides produce the same number for the
//! same file. Coefficients come from the payload (the JS side owns config).
use crate::json::Json;
use std::fs;

pub struct Feat { pub words: usize, pub punct: usize, pub indent: usize, pub chars: usize }

pub fn features(s: &str) -> Feat {
    let mut words = 0; let mut punct = 0; let mut indent = 0;
    let mut in_word = false; let mut ws_run = 0usize;
    for c in s.chars() {
        let is_word = c.is_ascii_alphanumeric() || c == '_'; // ASCII \w, as in the JS regex
        if is_word { if !in_word { words += 1; in_word = true; } } else { in_word = false; }
        if c == '\n' { indent += 1; if ws_run >= 2 { indent += 1; } ws_run = 0; continue; }
        if c == ' ' || c == '\t' { ws_run += 1; continue; }
        if ws_run >= 2 { indent += 1; }
        ws_run = 0;
        if !is_word && !c.is_whitespace() { punct += 1; }
    }
    if ws_run >= 2 { indent += 1; }
    Feat { words, punct, indent, chars: s.chars().count() }
}

fn est(f: &Feat, c: (f64, f64, f64)) -> f64 { (c.0 * f.words as f64 + c.1 * f.punct as f64 + c.2 * f.indent as f64).round() }

pub fn op_estimate(input: &Json) -> Json {
    let code = (input.num("code_w", 1.35), input.num("code_p", 0.72), input.num("code_s", 0.35));
    let prose = (input.num("prose_w", 1.18), input.num("prose_p", 0.55), input.num("prose_s", 0.25));
    let prose_suffix: Vec<String> = { let v = input.str_list("prose_suffix"); if v.is_empty() { vec![".md".into(), ".txt".into(), ".rst".into(), ".markdown".into(), ".mdx".into()] } else { v } };
    let mut files = Json::obj(); let mut total = 0f64; let mut bytes = 0f64; let mut missing = Vec::new();
    for p in input.str_list("paths") {
        let text = match fs::read(&p) { Ok(b) => String::from_utf8_lossy(&b).to_string(), Err(_) => { missing.push(Json::from(p)); continue; } };
        let lower = p.to_lowercase();
        let coef = if prose_suffix.iter().any(|s| lower.ends_with(s.as_str())) { prose } else { code };
        let n = est(&features(&text), coef);
        bytes += text.len() as f64; total += n;
        files.set(&p, n.into());
    }
    let mut out = Json::obj();
    out.set("files", files); out.set("total", total.into()); out.set("bytes", bytes.into()); out.set("missing", Json::Arr(missing));
    out
}
