//! The compiled index: what `arc build` writes and `arc lookup` seeks into.
//!
//! The problem it solves is small and paid constantly. `bb`'s PreToolUse search
//! guard asks one question — "is this name already declared somewhere, and
//! where" — on EVERY tool call a session makes. The answer already exists as
//! `.bundlebox/out/snapgen/symbols-*.md`, which on this tree is about 20,000
//! lines of `name  file:line` across six tables. Answering from those means
//! reading every byte and running a regex over every line, per tool call, to
//! return at most fourteen rows.
//!
//! So arc compiles them once. The format is deliberately the simplest thing
//! that answers all three query shapes the guard uses in O(log n) with two
//! seeks and no full read:
//!
//! ```text
//! magic     "ARC1"                4 bytes
//! count     u32                   records
//! pool_len  u32                   bytes in the string pool
//! built     u64                   unix seconds, for the staleness report
//! fwd       [count] u32           record ids, sorted by lowercased name
//! rev       [count] u32           record ids, sorted by REVERSED lowercased name
//! recs      [count] Rec           24 bytes each, in insertion order
//! pool      [pool_len] u8         every distinct name and path, once
//! ```
//!
//! `Rec` is `{name_off u32, name_len u16, file_off u32, file_len u16, line u32,
//! pad u32}` — fixed width, so record `i` is one seek and the offset arrays hold
//! ids rather than byte offsets.
//!
//! Two orderings, because `endsWith` is the one shape a single sorted table
//! cannot answer: a suffix query becomes a PREFIX query over the reversed
//! strings, which is the same binary search against `rev`. Exact and prefix come
//! from `fwd`. That is the whole trick, and it is why this needs no transducer.
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};

pub const MAGIC: &[u8; 4] = b"ARC1";
pub const HEADER: u64 = 4 + 4 + 4 + 8;
pub const REC: u64 = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub symbol: String,
    pub file: String,
    pub line: u32,
}

/// `name  file:line` out of one table. Anything that is not that shape is a
/// heading, a blank or a note, and is skipped in silence — the tables are
/// documents for a person to read as well as an index.
pub fn parse_table(text: &str) -> Vec<Row> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with('|') {
            continue;
        }
        // name, then whitespace, then file:line. The name may not contain
        // whitespace; a path may not either, in a table this wrote itself.
        let mut it = t.split_whitespace();
        let (Some(name), Some(loc)) = (it.next(), it.next()) else { continue };
        if it.next().is_some() {
            continue;
        }
        let Some(cut) = loc.rfind(':') else { continue };
        let Ok(line_no) = loc[cut + 1..].parse::<u32>() else { continue };
        if name.is_empty() || cut == 0 {
            continue;
        }
        out.push(Row { symbol: name.to_string(), file: loc[..cut].to_string(), line: line_no });
    }
    out
}

fn rev(s: &str) -> String {
    s.chars().rev().collect()
}

/// Write the index. Returns (records, bytes).
pub fn build(path: &str, rows: &[Row], built: u64) -> std::io::Result<(usize, u64)> {
    // The pool holds each distinct string once. On this tree that is a third of
    // the bytes: a file path is repeated by every symbol declared in it.
    let mut pool: Vec<u8> = Vec::new();
    let mut seen: BTreeMap<String, (u32, u16)> = BTreeMap::new();
    let intern = |s: &str, pool: &mut Vec<u8>, seen: &mut BTreeMap<String, (u32, u16)>| -> (u32, u16) {
        if let Some(&v) = seen.get(s) {
            return v;
        }
        let off = pool.len() as u32;
        pool.extend_from_slice(s.as_bytes());
        let v = (off, s.len() as u16);
        seen.insert(s.to_string(), v);
        v
    };

    let mut recs: Vec<[u8; REC as usize]> = Vec::with_capacity(rows.len());
    let mut keys: Vec<(String, u32)> = Vec::with_capacity(rows.len());
    for (i, r) in rows.iter().enumerate() {
        let (no, nl) = intern(&r.symbol, &mut pool, &mut seen);
        let (fo, fl) = intern(&r.file, &mut pool, &mut seen);
        let mut b = [0u8; REC as usize];
        b[0..4].copy_from_slice(&no.to_le_bytes());
        b[4..6].copy_from_slice(&nl.to_le_bytes());
        b[6..10].copy_from_slice(&fo.to_le_bytes());
        b[10..12].copy_from_slice(&fl.to_le_bytes());
        b[12..16].copy_from_slice(&r.line.to_le_bytes());
        recs.push(b);
        keys.push((r.symbol.to_lowercase(), i as u32));
    }

    let mut fwd = keys.clone();
    fwd.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut back: Vec<(String, u32)> = keys.iter().map(|(k, i)| (rev(k), *i)).collect();
    back.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    let mut f = File::create(path)?;
    f.write_all(MAGIC)?;
    f.write_all(&(rows.len() as u32).to_le_bytes())?;
    f.write_all(&(pool.len() as u32).to_le_bytes())?;
    f.write_all(&built.to_le_bytes())?;
    for (_, i) in &fwd {
        f.write_all(&i.to_le_bytes())?;
    }
    for (_, i) in &back {
        f.write_all(&i.to_le_bytes())?;
    }
    for b in &recs {
        f.write_all(b)?;
    }
    f.write_all(&pool)?;
    f.flush()?;
    let bytes = HEADER + (rows.len() as u64) * 8 + (rows.len() as u64) * REC + pool.len() as u64;
    Ok((rows.len(), bytes))
}

pub struct Reader {
    f: File,
    pub count: u32,
    pub pool_len: u32,
    pub built: u64,
}

impl Reader {
    pub fn open(path: &str) -> std::io::Result<Reader> {
        let mut f = File::open(path)?;
        let mut head = [0u8; HEADER as usize];
        f.read_exact(&mut head)?;
        if &head[0..4] != MAGIC {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not an arc index"));
        }
        let count = u32::from_le_bytes(head[4..8].try_into().unwrap());
        let pool_len = u32::from_le_bytes(head[8..12].try_into().unwrap());
        let built = u64::from_le_bytes(head[12..20].try_into().unwrap());
        Ok(Reader { f, count, pool_len, built })
    }

    fn fwd_at(&mut self, i: u32) -> std::io::Result<u32> {
        self.u32_at(HEADER + (i as u64) * 4)
    }
    fn rev_at(&mut self, i: u32) -> std::io::Result<u32> {
        self.u32_at(HEADER + (self.count as u64) * 4 + (i as u64) * 4)
    }
    fn u32_at(&mut self, off: u64) -> std::io::Result<u32> {
        let mut b = [0u8; 4];
        self.f.seek(SeekFrom::Start(off))?;
        self.f.read_exact(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }
    fn rec(&mut self, id: u32) -> std::io::Result<(u32, u16, u32, u16, u32)> {
        let off = HEADER + (self.count as u64) * 8 + (id as u64) * REC;
        let mut b = [0u8; REC as usize];
        self.f.seek(SeekFrom::Start(off))?;
        self.f.read_exact(&mut b)?;
        Ok((
            u32::from_le_bytes(b[0..4].try_into().unwrap()),
            u16::from_le_bytes(b[4..6].try_into().unwrap()),
            u32::from_le_bytes(b[6..10].try_into().unwrap()),
            u16::from_le_bytes(b[10..12].try_into().unwrap()),
            u32::from_le_bytes(b[12..16].try_into().unwrap()),
        ))
    }
    fn s(&mut self, off: u32, len: u16) -> std::io::Result<String> {
        let base = HEADER + (self.count as u64) * 8 + (self.count as u64) * REC;
        let mut b = vec![0u8; len as usize];
        self.f.seek(SeekFrom::Start(base + off as u64))?;
        self.f.read_exact(&mut b)?;
        Ok(String::from_utf8_lossy(&b).to_string())
    }

    pub fn row(&mut self, id: u32) -> std::io::Result<Row> {
        let (no, nl, fo, fl, line) = self.rec(id)?;
        Ok(Row { symbol: self.s(no, nl)?, file: self.s(fo, fl)?, line })
    }

    /// The first position in `fwd` (or `rev`) whose key is >= `needle`. The key
    /// is read through the record, so the sorted arrays stay 4 bytes a slot and
    /// a search is log2(n) seeks — fourteen of them on this tree.
    fn lower_bound(&mut self, needle: &str, reversed: bool) -> std::io::Result<u32> {
        let (mut lo, mut hi) = (0u32, self.count);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let id = if reversed { self.rev_at(mid)? } else { self.fwd_at(mid)? };
            let (no, nl, _, _, _) = self.rec(id)?;
            let name = self.s(no, nl)?.to_lowercase();
            let key = if reversed { rev(&name) } else { name };
            if key.as_str() < needle {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        Ok(lo)
    }

    /// Every row whose lowercased name starts with `p` (or, reversed, ends with
    /// it). Walks forward from the lower bound while the prefix still holds, so
    /// the cost is the answer's size and not the index's.
    pub fn prefix(&mut self, p: &str, reversed: bool, cap: usize) -> std::io::Result<Vec<u32>> {
        let needle = if reversed { rev(p) } else { p.to_string() };
        let mut i = self.lower_bound(&needle, reversed)?;
        let mut out = Vec::new();
        while i < self.count && out.len() < cap {
            let id = if reversed { self.rev_at(i)? } else { self.fwd_at(i)? };
            let (no, nl, _, _, _) = self.rec(id)?;
            let name = self.s(no, nl)?.to_lowercase();
            let key = if reversed { rev(&name) } else { name };
            if !key.starts_with(&needle) {
                break;
            }
            out.push(id);
            i += 1;
        }
        Ok(out)
    }
}
