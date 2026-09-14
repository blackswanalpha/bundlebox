//! A minimal JSON value with a parser and a writer. Enough for the kernel's
//! stdin/stdout contract; not a general library.
use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(BTreeMap<String, Json>),
}

impl Json {
    pub fn get(&self, k: &str) -> Option<&Json> { if let Json::Obj(m) = self { m.get(k) } else { None } }
    pub fn as_str(&self) -> Option<&str> { if let Json::Str(s) = self { Some(s) } else { None } }
    pub fn as_f64(&self) -> Option<f64> { if let Json::Num(n) = self { Some(*n) } else { None } }
    pub fn as_bool(&self) -> Option<bool> { if let Json::Bool(b) = self { Some(*b) } else { None } }
    pub fn as_arr(&self) -> Option<&Vec<Json>> { if let Json::Arr(a) = self { Some(a) } else { None } }
    pub fn str_list(&self, k: &str) -> Vec<String> {
        self.get(k).and_then(|v| v.as_arr()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
    }
    pub fn num(&self, k: &str, d: f64) -> f64 { self.get(k).and_then(|v| v.as_f64()).unwrap_or(d) }
    pub fn string(&self, k: &str, d: &str) -> String { self.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string() }
    pub fn obj() -> Json { Json::Obj(BTreeMap::new()) }
    pub fn set(&mut self, k: &str, v: Json) { if let Json::Obj(m) = self { m.insert(k.to_string(), v); } }
    pub fn to_string(&self) -> String { let mut s = String::new(); self.write(&mut s); s }
    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => { if n.fract() == 0.0 && n.abs() < 1e15 { let _ = write!(out, "{}", *n as i64); } else { let _ = write!(out, "{}", n); } }
            Json::Str(s) => write_str(s, out),
            Json::Arr(a) => { out.push('['); for (i, v) in a.iter().enumerate() { if i > 0 { out.push(','); } v.write(out); } out.push(']'); }
            Json::Obj(m) => { out.push('{'); for (i, (k, v)) in m.iter().enumerate() { if i > 0 { out.push(','); } write_str(k, out); out.push(':'); v.write(out); } out.push('}'); }
        }
    }
}
fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"), '\n' => out.push_str("\\n"), '\r' => out.push_str("\\r"), '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => { let _ = write!(out, "\\u{:04x}", c as u32); }
            c => out.push(c),
        }
    }
    out.push('"');
}
impl From<&str> for Json { fn from(s: &str) -> Json { Json::Str(s.to_string()) } }
impl From<String> for Json { fn from(s: String) -> Json { Json::Str(s) } }
impl From<f64> for Json { fn from(n: f64) -> Json { Json::Num(n) } }
impl From<usize> for Json { fn from(n: usize) -> Json { Json::Num(n as f64) } }
impl From<i64> for Json { fn from(n: i64) -> Json { Json::Num(n as f64) } }
impl From<i32> for Json { fn from(n: i32) -> Json { Json::Num(n as f64) } }
impl From<bool> for Json { fn from(b: bool) -> Json { Json::Bool(b) } }
impl From<Vec<Json>> for Json { fn from(a: Vec<Json>) -> Json { Json::Arr(a) } }

pub fn parse(s: &str) -> Result<Json, String> {
    let b = s.as_bytes();
    let mut i = 0;
    let v = value(b, &mut i)?;
    ws(b, &mut i);
    if i != b.len() { return Err(format!("trailing data at {}", i)); }
    Ok(v)
}
fn ws(b: &[u8], i: &mut usize) { while *i < b.len() && matches!(b[*i], b' ' | b'\n' | b'\r' | b'\t') { *i += 1; } }
fn value(b: &[u8], i: &mut usize) -> Result<Json, String> {
    ws(b, i);
    if *i >= b.len() { return Err("unexpected end".into()); }
    match b[*i] {
        b'{' => { *i += 1; let mut m = BTreeMap::new(); ws(b, i); if *i < b.len() && b[*i] == b'}' { *i += 1; return Ok(Json::Obj(m)); }
            loop { ws(b, i); let k = string(b, i)?; ws(b, i); if *i >= b.len() || b[*i] != b':' { return Err("expected :".into()); } *i += 1; let v = value(b, i)?; m.insert(k, v); ws(b, i);
                if *i >= b.len() { return Err("unterminated object".into()); } if b[*i] == b',' { *i += 1; continue; } if b[*i] == b'}' { *i += 1; return Ok(Json::Obj(m)); } return Err("expected , or }".into()); } }
        b'[' => { *i += 1; let mut a = Vec::new(); ws(b, i); if *i < b.len() && b[*i] == b']' { *i += 1; return Ok(Json::Arr(a)); }
            loop { let v = value(b, i)?; a.push(v); ws(b, i); if *i >= b.len() { return Err("unterminated array".into()); } if b[*i] == b',' { *i += 1; continue; } if b[*i] == b']' { *i += 1; return Ok(Json::Arr(a)); } return Err("expected , or ]".into()); } }
        b'"' => Ok(Json::Str(string(b, i)?)),
        b't' => { if b[*i..].starts_with(b"true") { *i += 4; Ok(Json::Bool(true)) } else { Err("bad literal".into()) } }
        b'f' => { if b[*i..].starts_with(b"false") { *i += 5; Ok(Json::Bool(false)) } else { Err("bad literal".into()) } }
        b'n' => { if b[*i..].starts_with(b"null") { *i += 4; Ok(Json::Null) } else { Err("bad literal".into()) } }
        _ => { let s = *i; while *i < b.len() && (b[*i].is_ascii_digit() || matches!(b[*i], b'-' | b'+' | b'.' | b'e' | b'E')) { *i += 1; }
            std::str::from_utf8(&b[s..*i]).ok().and_then(|t| t.parse::<f64>().ok()).map(Json::Num).ok_or_else(|| format!("bad number at {}", s)) }
    }
}
fn string(b: &[u8], i: &mut usize) -> Result<String, String> {
    if *i >= b.len() || b[*i] != b'"' { return Err("expected string".into()); }
    *i += 1;
    let mut out: Vec<u8> = Vec::new();
    while *i < b.len() {
        let c = b[*i];
        if c == b'"' { *i += 1; return String::from_utf8(out).map_err(|e| e.to_string()); }
        if c == b'\\' {
            *i += 1; if *i >= b.len() { break; }
            match b[*i] {
                b'"' => out.push(b'"'), b'\\' => out.push(b'\\'), b'/' => out.push(b'/'), b'n' => out.push(b'\n'), b'r' => out.push(b'\r'), b't' => out.push(b'\t'), b'b' => out.push(8), b'f' => out.push(12),
                b'u' => { if *i + 4 >= b.len() { break; } let h = std::str::from_utf8(&b[*i + 1..*i + 5]).map_err(|e| e.to_string())?; let mut cp = u32::from_str_radix(h, 16).map_err(|e| e.to_string())?; *i += 4;
                    if (0xD800..0xDC00).contains(&cp) && *i + 6 < b.len() && b[*i + 1] == b'\\' && b[*i + 2] == b'u' { let h2 = std::str::from_utf8(&b[*i + 3..*i + 7]).map_err(|e| e.to_string())?; let lo = u32::from_str_radix(h2, 16).map_err(|e| e.to_string())?; cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); *i += 6; }
                    let ch = char::from_u32(cp).unwrap_or('\u{FFFD}'); let mut buf = [0u8; 4]; out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes()); }
                _ => return Err("bad escape".into()),
            }
            *i += 1;
        } else { out.push(c); *i += 1; }
    }
    Err("unterminated string".into())
}
