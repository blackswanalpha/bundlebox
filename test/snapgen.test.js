// snapgen.test.js — the reference tables against a fixture repo in tmpdir.
// BB_ROOT is set BEFORE any src module loads because paths.js fixes ROOT at
// import. The symbols test runs once with BB_KERNEL pointed at nothing (JS
// path) and once with the built kernel when it exists, so the two matchers are
// pinned to the same answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-snapgen-")));
process.env.BB_ROOT = root;
const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };

w("package.json", JSON.stringify({ name: "fixture", type: "module", bin: { fx: "bin/fx.js" }, scripts: { test: "node --test", lint: "eslint ." }, dependencies: { express: "^4.19.0", lodash: "^4.17.21" } }));
w("Makefile", "build:\n\techo hi\n\ntest: build\n\tnode --test\n");
w("src/server.js", `import express from "express";
export function makeApp() {
  const app = express();
  app.get("/health", (req, res) => res.send("ok"));
  app.post("/users/:id", (req, res) => res.send("ok"));
  return app;
}
export const PORT = 3000;
`);
w("src/util.js", "export function first(a) {\n  return a[0];\n}\nfunction _private() {}\n");
w("api/models.py", "import os\n\nclass Model:\n    def run(self):\n        return 1\n\n\ndef helper():\n    return 2\n");
w("test/server.test.js", "import { makeApp } from '../src/server.js';\ntest('x', () => makeApp());\n");
w("README.md", "# Fixture\n\nsome words\n");

const PKG = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BBK = path.join(PKG, "kernel", "target", "release", "bbk");
const kernelBuilt = fs.existsSync(BBK);

const tables = await import("../src/snapgen/tables.js");
const snapgen = await import("../src/snapgen/index.js");

async function symbolsVia(mode) {
  process.env.BB_KERNEL = mode === "js" ? "/nonexistent" : BBK;
  tables.resetRegistry();
  const rows = await snapgen.build({ force: true });
  const idx = tables.symbolIndex();
  const src = fs.readFileSync(snapgen.tablePath("symbols-src"), "utf8");
  const api = fs.readFileSync(snapgen.tablePath("symbols-api"), "utf8");
  return { rows, via: idx.via, src, api };
}

test("symbols tables: a JS function and a Python class, JS path", async () => {
  const r = await symbolsVia("js");
  assert.equal(r.via, "js");
  assert.match(r.src, /^makeApp\s+src\/server\.js:2$/m);
  assert.match(r.src, /^PORT\s+src\/server\.js:8$/m);
  assert.match(r.api, /^Model\s+api\/models\.py:3$/m);
  assert.match(r.api, /^helper\s+api\/models\.py:8$/m);
  assert.doesNotMatch(r.api, /^run\s/m, "a method is not top-level");
  assert.doesNotMatch(r.src, /_private/, "private helpers are not listed");
  assert.ok(r.rows.every((x) => x.state === "built"), JSON.stringify(r.rows.filter((x) => x.state !== "built")));
});

test("symbols tables: the kernel gives the same answer", { skip: !kernelBuilt && "kernel not built" }, async () => {
  const js = await symbolsVia("js");
  const k = await symbolsVia("kernel");
  assert.equal(k.via, "kernel");
  assert.equal(k.src, js.src);
  assert.equal(k.api, js.api);
});

test("routes table detects the express routes", async () => {
  const text = fs.readFileSync(snapgen.tablePath("routes"), "utf8");
  assert.match(text, /\| express-style \| GET \| `\/health` \| src\/server\.js:4 \|/);
  assert.match(text, /\| express-style \| POST \| `\/users\/:id` \| src\/server\.js:5 \|/);
  assert.doesNotMatch(text, /none detected/);
});

test("routes table says (none detected) explicitly", () => {
  assert.match(tables.renderRoutes(tables.routeRows([path.join(root, "src/util.js")])), /^\(none detected\)$/m);
});

test("layout, commands, docs, tests, deps, hot are built and say what they found", async () => {
  const read = (n) => fs.readFileSync(snapgen.tablePath(n), "utf8");
  assert.match(read("layout"), /Manifests: `package.json`, `Makefile`/);
  assert.match(read("layout"), /\| `src\/` \| 2 \|/);
  assert.match(read("commands"), /`npm run test`/);
  assert.match(read("commands"), /`make build`/);
  assert.match(read("commands"), /`fx` → `bin\/fx.js`/);
  assert.match(read("docs"), /\| `README.md` \| Fixture \| 3 \|/);
  assert.match(read("tests"), /\| `test\/server.test.js` \| server.js \|/);
  assert.match(read("deps"), /\| `express` \| \^4.19.0 \| package.json dependencies \| 1 \|/);
  assert.match(read("deps"), /\| `lodash` \| \^4.17.21 \| package.json dependencies \| 0 \|/);
  assert.match(read("hot"), /Source: none: no signals measured and no git history/);
  assert.ok(fs.existsSync(snapgen.indexPath()));
});

test("symbolHits reads the tables and ranks by term", async () => {
  const hits = await snapgen.symbolHits(["makeApp", "model", "get"]);
  assert.ok(hits.some((h) => h.symbol === "makeApp" && h.file === "src/server.js" && h.line === 2));
  assert.ok(hits.some((h) => h.symbol === "Model" && h.file === "api/models.py"));
  assert.ok(!hits.some((h) => h.term === "get"), "three-letter terms are ignored");
});

test("stale after a touch, fresh after a rebuild", async () => {
  fs.appendFileSync(path.join(root, "src/util.js"), "export const Z = 1;\n");
  const before = await snapgen.stale({ only: ["symbols-src"] });
  assert.equal(before[0].state, "stale");
  await snapgen.build({ only: ["symbols-src"] });
  const after = await snapgen.stale({ only: ["symbols-src"] });
  assert.equal(after[0].state, "fresh");
});
