"""A graded distance over the symbol tables, with no weights to download.

prompt4.md W3. `ambiguity()` had only presence tests and the symbol index
answers a boolean, so a locate that matched three irrelevant symbols read as
located. The signal string equality cannot reach is co-occurrence: `laneModel`
and `assignCheckouts` are related because they sit in `router.js` together,
which no edit distance between their names will say.

The matrix is symbol × term, built from `symbols-*.md` — one row per declared
symbol, its terms the camel/snake pieces of its name plus the segments of its
path. A truncated SVD of that matrix gives every term a K-dimensional vector,
and two term sets compare by the cosine of their summed vectors. Deterministic
(seeded), stdlib only, and the whole table is a few hundred kilobytes of JSON
the JS side reads back in `src/pinpoint/rank.js`.

Tokenisation mirrors `terms()` in `src/pinpoint/index.js`: same stoplist, same
three-letter floor, same camel/snake split. A distance between two vocabularies
is only a distance if both sides were cut the same way.
"""
from __future__ import annotations
import math
import random
import re

K = 16
ITERS = 24
STOP = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "that", "this", "with", "when", "not",
        "does", "do", "be", "are", "as", "at", "by", "from", "into", "no", "but", "so", "if", "then", "than", "its", "their", "his", "her",
        "them", "our", "we", "you", "should", "must", "never", "always", "after", "before", "every", "all", "any", "one", "was", "were",
        "has", "have", "had", "can", "could", "would", "will", "there", "here", "what", "why", "how", "where", "which", "who", "get", "set",
        "fix", "bug", "issue", "make", "add", "remove", "change", "update", "implement", "refactor", "write", "build", "create", "delete",
        "check", "verify", "test", "tests", "investigate", "handle", "support", "use", "using", "via", "new", "old", "file", "files",
        "function", "method", "code", "error", "errors", "wrong", "broken", "fails", "failing", "failed", "work", "works", "working"}
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_./-]{2,}")
_PIECE = re.compile(r"[A-Z]?[a-z0-9]+")
_ROW = re.compile(r"^(\S+)\s+(\S+):(\d+)\s*$")


def terms(text: str) -> list:
    """Words of three or more letters minus the stoplist, plus the camel/snake
    pieces longer than three. Lower-cased, deduplicated, order kept."""
    seen, out = set(), []

    def push(w):
        l = w.lower()
        if len(l) < 3 or l in STOP or l in seen:
            return
        seen.add(l)
        out.append(l)
    for w in _WORD.findall(str(text or "")):
        push(w)
        for p in _PIECE.findall(w):
            if len(p) > 3:
                push(p)
    return out


def path_terms(file: str) -> list:
    """Directory names, the stem and its pieces; the extension is not a term."""
    parts = re.split(r"[/\\\\]", str(file or ""))
    stem = re.sub(r"\.[a-z0-9]+$", "", parts[-1]) if parts else ""
    return terms(" ".join(parts[:-1] + [stem]).replace(".", " "))


def rows(tables: dict) -> list:
    """[(symbol, file, [terms])] from the text of each `symbols-*.md` table."""
    out = []
    for _, text in sorted(tables.items()):
        for line in str(text or "").splitlines():
            m = _ROW.match(line)
            if not m:
                continue
            name, file = m.group(1), m.group(2)
            ts = terms(name) + path_terms(file)
            if ts:
                out.append((name, file, sorted(set(ts))))
    return out


def _orthonormalise(V: list) -> list:
    """Modified Gram-Schmidt over the columns of V (a list of k term-vectors)."""
    out = []
    for v in V:
        v = list(v)
        for u in out:
            d = sum(a * b for a, b in zip(v, u))
            v = [a - d * b for a, b in zip(v, u)]
        n = math.sqrt(sum(a * a for a in v))
        out.append([a / n for a in v] if n > 1e-12 else v)
    return out


def build(tables: dict, k: int = K, iters: int = ITERS, seed: int = 7) -> dict:
    """Subspace iteration on AᵀA for the top-k right singular vectors of the
    tf-idf symbol × term matrix. Each term's vector is its row of V scaled by
    the singular value, so a dimension that explains more of the table weighs
    more in the cosine."""
    R = rows(tables)
    if len(R) < 8:
        return {"useful": False, "why": f"{len(R)} symbol rows; need 8", "n_rows": len(R), "n_terms": 0, "k": 0, "terms": {}}
    df: dict = {}
    for _, _, ts in R:
        for t in ts:
            df[t] = df.get(t, 0) + 1
    vocab = sorted(t for t, c in df.items() if c >= 2)   # a term in one symbol relates it to nothing
    if len(vocab) < 8:
        return {"useful": False, "why": f"{len(vocab)} shared terms; need 8", "n_rows": len(R), "n_terms": len(vocab), "k": 0, "terms": {}}
    idx = {t: i for i, t in enumerate(vocab)}
    n = len(R)
    A = []   # sparse rows: [(col, weight)]
    for _, _, ts in R:
        cols = [(idx[t], math.log((n + 1) / df[t])) for t in ts if t in idx]
        norm = math.sqrt(sum(w * w for _, w in cols)) or 1.0
        A.append([(c, w / norm) for c, w in cols])
    k = max(2, min(k, len(vocab) - 1))
    rnd = random.Random(seed)
    V = _orthonormalise([[rnd.gauss(0, 1) for _ in range(len(vocab))] for _ in range(k)])
    for _ in range(iters):
        # Y = A V  (n × k), then Z = Aᵀ Y  (terms × k), column by column
        Z = []
        for v in V:
            y = [sum(v[c] * w for c, w in row) for row in A]
            z = [0.0] * len(vocab)
            for yi, row in zip(y, A):
                if yi:
                    for c, w in row:
                        z[c] += yi * w
            Z.append(z)
        V = _orthonormalise(Z)
    # singular values: ||A v||
    sig = [math.sqrt(sum(sum(v[c] * w for c, w in row) ** 2 for row in A)) for v in V]
    vecs = {t: [round(V[j][i] * sig[j], 4) for j in range(k)] for t, i in idx.items()}
    return {"useful": True, "k": k, "iters": iters, "n_rows": n, "n_terms": len(vocab),
            "singular": [round(s, 3) for s in sig], "terms": vecs}


def vector(space: dict, ts: list) -> tuple:
    """(summed vector, known, of) for a term list; unknown terms are skipped
    and counted, because a distance over one known word in twelve is not one."""
    tv = (space or {}).get("terms") or {}
    k = int((space or {}).get("k") or 0)
    acc, known, seen = [0.0] * k, 0, set()
    for t in ts:
        l = str(t).lower()
        if l in seen:
            continue
        seen.add(l)
        v = tv.get(l)
        if v is None:
            continue
        known += 1
        for i, x in enumerate(v):
            acc[i] += x
    return acc, known, len(seen)


def distance(space: dict, a: list, b: list, min_coverage: float = 0.5):
    """Cosine in [0, 1] between two term sets, or None when either side is
    under `min_coverage` known — an unmeasured pair is not a far one."""
    va, ka, na = vector(space, a)
    vb, kb, nb = vector(space, b)
    if not na or not nb or ka / na < min_coverage or kb / nb < min_coverage:
        return None
    dot = sum(x * y for x, y in zip(va, vb))
    la = math.sqrt(sum(x * x for x in va))
    lb = math.sqrt(sum(x * x for x in vb))
    if la < 1e-12 or lb < 1e-12:
        return None
    return round(max(0.0, min(1.0, dot / (la * lb))), 4)
