// arc.test.js — the compiled index, and the contract its two readers share.
//
// The measurement this design rests on: answering "where is this name declared"
// from the markdown tables costs 1.80ms, from the compiled index 0.14ms in a
// cold process — and 2.28ms by spawning the Rust binary, because the process
// itself costs 2.20ms. So `arc` is the compiler and src/arc/read.js is the
// reader, and the test that matters is that the two agree on every query shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-arc-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
w("package.json", JSON.stringify({ name: "fixture", type: "module" }));

// Every shape the guard asks for, plus the rows a parser must skip.
w(".bundlebox/out/snapgen/symbols-src.md", [
  "# symbols-src — declarations in `src/`",
  "",
  "`name  file:line`, top-level only (4 symbols, 3 files). Grep this before grepping the tree.",
  "",
  "loginToken  src/token.js:12",
  "refreshSession  src/session.js:401",
  "readVerdict  src/wire/brief.js:142",
  "searchVerdict  src/wire/brief.js:247",
  "| a | table | row |",
  "not a symbol row at all",
].join("\n") + "\n");
w(".bundlebox/out/snapgen/symbols-test.md", "helperFn  test/helper.test.js:3\n");

const arc = await import("../src/arc/index.js");
const read = arc.read;

const built = arc.build();
const haveBinary = Boolean(arc.BIN());

test("the binary compiles every table into one index", { skip: haveBinary ? false : "arc is not built (cargo build --release --manifest-path arc/Cargo.toml)" }, () => {
  assert.ok(built && !built.error, JSON.stringify(built));
  assert.equal(built.symbols, 5, "four from src, one from test; the heading, the table row and the prose are not symbols");
  assert.ok(fs.existsSync(read.FILE()));
  const st = read.stat();
  assert.equal(st.symbols, 5);
  assert.ok(st.bytes > 0 && st.age_seconds < 120);
});

test("exact, prefix and suffix each come back", { skip: haveBinary ? false : "arc is not built" }, () => {
  assert.deepEqual(read.lookup(["loginToken"], { shapes: ["exact"] }), [{ symbol: "loginToken", file: "src/token.js", line: 12 }]);
  assert.deepEqual(read.lookup(["login"], { shapes: ["prefix"] }).map((r) => r.symbol), ["loginToken"]);
  // The suffix query is the one a single sorted table cannot answer: it is a
  // prefix search over the reversed names.
  assert.deepEqual(read.lookup(["Verdict"], { shapes: ["suffix"] }).map((r) => r.symbol).sort(), ["readVerdict", "searchVerdict"]);
  assert.deepEqual(read.lookup(["notdeclaredanywhere"], {}), []);
});

test("case does not matter and a cap holds", { skip: haveBinary ? false : "arc is not built" }, () => {
  assert.equal(read.lookup(["LOGINTOKEN"], { shapes: ["exact"] }).length, 1);
  // Three names end in "n": loginToken, refreshSession, helperFn.
  assert.equal(read.lookup(["n"], { shapes: ["suffix"] }).length, 3);
  assert.equal(read.lookup(["n"], { shapes: ["suffix"], cap: 2 }).length, 2, "the cap holds");
});

test("`under` restricts the answer to one directory", { skip: haveBinary ? false : "arc is not built" }, () => {
  assert.deepEqual(read.lookup(["helperFn"], { under: "test/" }).map((r) => r.file), ["test/helper.test.js"]);
  assert.deepEqual(read.lookup(["helperFn"], { under: "src/" }), [], "the declaration is in test/, and this question was about src/");
});

test("both readers answer every query identically", { skip: haveBinary ? false : "arc is not built" }, () => {
  const bin = arc.BIN();
  for (const [terms, shapes] of [[["loginToken"], ["exact"]], [["login"], ["prefix"]], [["Verdict"], ["suffix"]],
    [["refreshSession", "helperFn"], ["exact"]], [["zzz"], ["prefix"]]]) {
    const js = read.lookup(terms, { shapes, cap: 14 }).map((r) => `${r.file}:${r.line} ${r.symbol}`).sort();
    const rs = (arc.lookupVia(bin, terms, { shapes, cap: 14 }) || []).map((r) => `${r.file}:${r.line} ${r.symbol}`).sort();
    assert.deepEqual(rs, js, `the two readers disagree on ${JSON.stringify(terms)} ${JSON.stringify(shapes)}`);
  }
});

test("a missing index returns null, which is not an empty answer", () => {
  read.reset();
  assert.equal(read.lookup(["loginToken"], { file: path.join(root, "nope.arc") }), null);
});

test("a truncated index is refused rather than half-answered", () => {
  const p = path.join(root, "half.arc");
  if (!fs.existsSync(read.FILE())) return;                   // nothing to truncate without the binary
  const whole = fs.readFileSync(read.FILE());
  fs.writeFileSync(p, whole.subarray(0, Math.floor(whole.length / 2)));
  read.reset();
  assert.equal(read.lookup(["loginToken"], { file: p }), null);
});

test("a file that is not an index is refused", () => {
  const p = path.join(root, "not-an-index.arc");
  fs.writeFileSync(p, "this is not an arc index at all, it is prose");
  read.reset();
  assert.equal(read.lookup(["loginToken"], { file: p }), null);
});
