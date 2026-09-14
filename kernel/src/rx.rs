//! rx.rs — the regex subset `json_matches` is allowed to use.
//!
//! A scenario asserts things like an id shape or an error message, so a corpus
//! needs a pattern language. A full engine is a dependency and a second
//! implementation of something JS already has, so this is deliberately a
//! SUBSET: literals, `.`, `\d \w \s` and their negations, classes with ranges
//! and negation, `* + ?`, `^ $`, `|`, groups. Anything outside it — `{n,m}`,
//! lookaround, backreferences, inline flags — is an ERROR, not a guess, and
//! `bb cookbook check` routes a corpus using one to the JS runner instead.
//! Unanchored, like `RegExp.test`. `test/kernel.test.js` pins this against
//! JavaScript's own answer for every pattern the shipped corpora use.

#[derive(Debug, Clone)]
enum Node { Char(char), Any, Class(Vec<(char, char)>, bool), Group(Alt), Start, End }

#[derive(Debug, Clone)]
struct Piece { node: Node, min: u32, max: u32 }

#[derive(Debug, Clone)]
struct Seq(Vec<Piece>);

#[derive(Debug, Clone)]
struct Alt(Vec<Seq>);

struct P<'a> { c: &'a [char], i: usize }

impl<'a> P<'a> {
    fn peek(&self) -> Option<char> { self.c.get(self.i).copied() }
    fn next(&mut self) -> Option<char> { let c = self.peek(); if c.is_some() { self.i += 1; } c }
    fn alt(&mut self) -> Result<Alt, String> {
        let mut branches = vec![self.seq()?];
        while self.peek() == Some('|') { self.i += 1; branches.push(self.seq()?); }
        Ok(Alt(branches))
    }
    fn seq(&mut self) -> Result<Seq, String> {
        let mut pieces = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' { break; }
            let node = self.atom()?;
            let (min, max) = match self.peek() {
                Some('*') => { self.i += 1; (0, u32::MAX) }
                Some('+') => { self.i += 1; (1, u32::MAX) }
                Some('?') => { self.i += 1; (0, 1) }
                Some('{') => return Err("{n,m} is outside the supported subset".into()),
                _ => (1, 1),
            };
            if self.peek() == Some('?') { return Err("lazy quantifiers are outside the supported subset".into()); }
            pieces.push(Piece { node, min, max });
        }
        Ok(Seq(pieces))
    }
    fn atom(&mut self) -> Result<Node, String> {
        match self.next().ok_or("unexpected end of pattern")? {
            '.' => Ok(Node::Any),
            '^' => Ok(Node::Start),
            '$' => Ok(Node::End),
            '(' => {
                if self.peek() == Some('?') {
                    // (?: is a plain group; every other (? form is lookaround or a flag.
                    if self.c.get(self.i + 1) == Some(&':') { self.i += 2; } else { return Err("(?...) is outside the supported subset".into()); }
                }
                let a = self.alt()?;
                if self.next() != Some(')') { return Err("unbalanced (".into()); }
                Ok(Node::Group(a))
            }
            ')' => Err("unbalanced )".into()),
            '[' => self.class(),
            '\\' => {
                let c = self.next().ok_or("trailing backslash")?;
                match c {
                    'd' => Ok(Node::Class(vec![('0', '9')], false)),
                    'D' => Ok(Node::Class(vec![('0', '9')], true)),
                    'w' => Ok(Node::Class(word(), false)),
                    'W' => Ok(Node::Class(word(), true)),
                    's' => Ok(Node::Class(space(), false)),
                    'S' => Ok(Node::Class(space(), true)),
                    'n' => Ok(Node::Char('\n')), 't' => Ok(Node::Char('\t')), 'r' => Ok(Node::Char('\r')),
                    '0'..='9' => Err("backreferences are outside the supported subset".into()),
                    'b' | 'B' => Err("word boundaries are outside the supported subset".into()),
                    c => Ok(Node::Char(c)),
                }
            }
            c => Ok(Node::Char(c)),
        }
    }
    fn class(&mut self) -> Result<Node, String> {
        let neg = self.peek() == Some('^');
        if neg { self.i += 1; }
        let mut ranges: Vec<(char, char)> = Vec::new();
        let mut first = true;
        loop {
            let c = self.next().ok_or("unterminated [")?;
            if c == ']' && !first { break; }
            first = false;
            let lo = if c == '\\' {
                let e = self.next().ok_or("trailing backslash in class")?;
                match e {
                    'd' => { ranges.push(('0', '9')); continue; }
                    'w' => { ranges.extend(word()); continue; }
                    's' => { ranges.extend(space()); continue; }
                    'n' => '\n', 't' => '\t', 'r' => '\r',
                    other => other,
                }
            } else { c };
            if self.peek() == Some('-') && self.c.get(self.i + 1).copied().map(|n| n != ']').unwrap_or(false) {
                self.i += 1;
                let hi = self.next().ok_or("unterminated range")?;
                ranges.push((lo, hi));
            } else { ranges.push((lo, lo)); }
        }
        Ok(Node::Class(ranges, neg))
    }
}

fn word() -> Vec<(char, char)> { vec![('a', 'z'), ('A', 'Z'), ('0', '9'), ('_', '_')] }
fn space() -> Vec<(char, char)> { vec![(' ', ' '), ('\t', '\t'), ('\n', '\n'), ('\r', '\r'), ('\u{b}', '\u{c}')] }

fn in_class(ranges: &[(char, char)], neg: bool, c: char) -> bool {
    let hit = ranges.iter().any(|(lo, hi)| c >= *lo && c <= *hi);
    hit != neg
}

fn m_alt(a: &Alt, s: &[char], pos: usize, k: &mut dyn FnMut(usize) -> bool) -> bool {
    a.0.iter().any(|seq| m_seq(seq, 0, s, pos, k))
}

fn m_seq(seq: &Seq, i: usize, s: &[char], pos: usize, k: &mut dyn FnMut(usize) -> bool) -> bool {
    if i >= seq.0.len() { return k(pos); }
    m_piece(seq, i, s, pos, 0, k)
}

/// Greedy with backtracking: take one more repetition if the maximum allows,
/// and fall through to the rest of the sequence once the minimum is met. A
/// repetition that consumed nothing is not repeated — `(a?)*` would otherwise
/// recurse forever on the same position.
fn m_piece(seq: &Seq, i: usize, s: &[char], pos: usize, count: u32, k: &mut dyn FnMut(usize) -> bool) -> bool {
    let p = &seq.0[i];
    if let Node::Start | Node::End = p.node {
        let holds = match p.node { Node::Start => pos == 0, Node::End => pos == s.len(), _ => false };
        return (holds || p.min == 0) && m_seq(seq, i + 1, s, pos, k);
    }
    if count < p.max {
        let took = m_node(&p.node, s, pos, &mut |e| {
            if e == pos { return count + 1 >= p.min && m_seq(seq, i + 1, s, pos, k); }
            m_piece(seq, i, s, e, count + 1, k)
        });
        if took { return true; }
    }
    count >= p.min && m_seq(seq, i + 1, s, pos, k)
}

fn m_node(n: &Node, s: &[char], pos: usize, k: &mut dyn FnMut(usize) -> bool) -> bool {
    match n {
        Node::Char(c) => s.get(pos).map(|x| x == c).unwrap_or(false) && k(pos + 1),
        Node::Any => pos < s.len() && s[pos] != '\n' && k(pos + 1),
        Node::Class(r, neg) => s.get(pos).map(|c| in_class(r, *neg, *c)).unwrap_or(false) && k(pos + 1),
        Node::Start => pos == 0 && k(pos),
        Node::End => pos == s.len() && k(pos),
        Node::Group(a) => m_alt(a, s, pos, k),
    }
}

/// `RegExp(pattern).test(subject)` for the supported subset. Err names the
/// construct that is outside it, so the caller can say so rather than answer.
pub fn test(pattern: &str, subject: &str) -> Result<bool, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut p = P { c: &chars, i: 0 };
    let ast = p.alt()?;
    if p.i != chars.len() { return Err(format!("unparsed pattern tail at {}", p.i)); }
    let s: Vec<char> = subject.chars().collect();
    for start in 0..=s.len() {
        if m_alt(&ast, &s, start, &mut |_| true) { return Ok(true); }
    }
    Ok(false)
}
