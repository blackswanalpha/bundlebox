// ui.test.js — the fourth step kind, and the one property that makes it worth
// having: a `ui` scenario replays with no model in it. Every selector and every
// expected string below was written once; running them again costs nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-ui-")));
const root = path.join(tmp, "ws");
fs.mkdirSync(path.join(root, ".bundlebox", "var"), { recursive: true });
process.env.BB_ROOT = root;
process.env.HOME = tmp;
const { parseUi, UI_VERBS } = await import("../src/cookbook/expect.js");
const corpus = await import("../src/cookbook/corpus.js");
const engine = await import("../src/cookbook/engine.js");
const drivers = await import("../src/cookbook/drivers/index.js");

const fixtures = path.join(import.meta.dirname, "fixtures");

test("parseUi: four verbs, and a line outside them is not a step", () => {
  assert.deepEqual(parseUi("open checkout.html"), { verb: "open", target: "checkout.html" });
  assert.deepEqual(parseUi("click #submit"), { verb: "click", selector: "#submit" });
  assert.deepEqual(parseUi("type #email a@b.c"), { verb: "type", selector: "#email", text: "a@b.c" });
  assert.deepEqual(parseUi('type #email "two words"'), { verb: "type", selector: "#email", text: "two words" });
  assert.deepEqual(parseUi('expect text "Pay now"'), { verb: "expect", what: "text", text: "Pay now" });
  assert.deepEqual(parseUi("expect visible #submit"), { verb: "expect", what: "visible", selector: "#submit" });
  assert.deepEqual(parseUi("expect absent #error"), { verb: "expect", what: "absent", selector: "#error" });
  assert.match(parseUi("swipe left").why, /not a ui verb/);
  assert.match(parseUi("click").why, /needs a selector/);
  assert.match(parseUi("expect #submit").why, /text <string>/);
  assert.match(parseUi("").why, /empty/);
  assert.deepEqual(UI_VERBS, ["open", "click", "type", "expect"]);
});

test("the page driver reads the markup and nothing else", async () => {
  const page = drivers.byId("page");
  assert.deepEqual(page.available(), { ok: true });
  const s = await page.open({ root: fixtures }, "");
  assert.equal((await page.act(s, parseUi("click #submit"))).why, "no page is open; the first `ui` step must be `open <path>`");
  assert.equal((await page.act(s, parseUi("open checkout.html"))).ok, true);
  assert.equal((await page.act(s, parseUi("type #email a@b.c"))).ok, true);
  assert.match((await page.act(s, parseUi("type #submit x"))).why, /is a <button>, which takes no typing/);
  assert.match((await page.act(s, parseUi("type #nope x"))).why, /nothing matches/);
  assert.equal((await page.act(s, parseUi('expect text "charged when you press"'))).ok, true);
  assert.match((await page.act(s, parseUi('expect text "free shipping"'))).why, /does not contain/);
  // hidden is what the markup says is hidden, and nothing more
  assert.match((await page.act(s, parseUi("expect visible #error"))).why, /in the page but hidden/);
  assert.equal((await page.act(s, parseUi("expect absent #error"))).ok, true);
  assert.equal((await page.act(s, parseUi("expect visible button.primary"))).ok, true);
  assert.equal((await page.act(s, parseUi("expect visible [name=email]"))).ok, true);
  assert.match((await page.act(s, parseUi("expect visible #coupon"))).why, /hidden/);
  // a link is the one action a file can really take
  assert.deepEqual((await page.act(s, parseUi("click #terms"))).got, { followed: "terms.html" });
  assert.equal((await page.act(s, parseUi('expect text "Refunds inside 14 days"'))).ok, true);
  await page.close(s);
});

test("a corpus with ui steps: green over the fixture page, and refused when the driver is not declared", async () => {
  const dir = path.join(root, ".bundlebox", "cookbook", "shop");
  fs.mkdirSync(path.join(dir, "scenarios", "01-checkout"), { recursive: true });
  const persona = (extra) => fs.writeFileSync(path.join(dir, "persona.json"),
    JSON.stringify({ title: "shop", who: "one buyer", base: "", rpm: 0, vars: {}, actors: {}, setup: [], ...extra }));
  fs.writeFileSync(path.join(dir, "surfaces.json"), JSON.stringify([{ id: "checkout", title: "Checkout", why: "the one page that takes money" }]));
  fs.writeFileSync(path.join(dir, "scenarios", "01-checkout", "01-pay.json"), JSON.stringify({
    id: "checkout-pay", surface: "checkout", severity: "high", title: "the pay button is there and says so",
    question: "can a buyer see what pressing it does?",
    rule: ["Orders are charged when you press Pay now (test/fixtures/checkout.html)"],
    steps: [
      { name: "the page opens", ui: "open checkout.html", precondition: true },
      { name: "an address goes in", ui: "type #email buyer@example.com" },
      { name: "the button is there", ui: "expect visible #submit" },
      { name: "and it says what it does", ui: 'expect text "charged when you press Pay now"' },
      { name: "nothing is already wrong", ui: "expect absent #error" },
    ],
  }));

  // Undeclared driver: refused by the check, before anything runs.
  persona({});
  let c = corpus.load("shop");
  let gate = corpus.check(c);
  assert.equal(gate.ok, false);
  assert.equal(gate.errors.filter((e) => /declares no `driver`/.test(e)).length, 5, gate.errors.join("\n"));

  // Declared but not a driver this install has.
  persona({ driver: "selenium" });
  gate = corpus.check(corpus.load("shop"));
  assert.ok(gate.errors.some((e) => /`selenium` is not a driver/.test(e)), gate.errors.join("\n"));

  // Declared: the check passes and the corpus runs, in the js engine, green.
  persona({ driver: "page" });
  c = corpus.load("shop");
  gate = corpus.check(c);
  assert.deepEqual(gate.errors, []);
  const spec = corpus.spec(c, { root: fixtures });
  assert.equal(spec.driver, "page");
  assert.equal(engine.pick(spec).engine, "js");
  assert.match(engine.pick(spec, { engine: "kernel" }).why, /`ui` steps/);
  const board = await engine.run(spec);
  assert.equal(board.engine, "js");
  assert.deepEqual(board.scenarios[0].steps.map((s) => s.state), ["passed", "passed", "passed", "passed", "passed"]);
  assert.equal(board.scenarios[0].state, "passed");
  assert.equal(board.totals.failed, 0);
  assert.equal(board.requests, 0, "a ui scenario makes no http request and spends no tokens");
});

test("a ui scenario of nothing but drives is refused: it would be green because nothing was checked", () => {
  const dir = path.join(root, ".bundlebox", "cookbook", "drives");
  fs.mkdirSync(path.join(dir, "scenarios", "01-checkout"), { recursive: true });
  fs.writeFileSync(path.join(dir, "persona.json"), JSON.stringify({ title: "drives", base: "", driver: "page", setup: [] }));
  fs.writeFileSync(path.join(dir, "surfaces.json"), JSON.stringify([{ id: "checkout", title: "Checkout", why: "x" }]));
  fs.writeFileSync(path.join(dir, "scenarios", "01-checkout", "01-drive.json"), JSON.stringify({
    id: "drive", surface: "checkout", severity: "low", title: "presses things", question: "?", rule: ["x"],
    steps: [{ name: "open", ui: "open checkout.html" }, { name: "press", ui: "click #submit" }],
  }));
  const gate = corpus.check(corpus.load("drives"));
  assert.ok(gate.errors.some((e) => /no step asserts anything/.test(e)), gate.errors.join("\n"));
});

test("the drivers that need a tool this box may not have report it, they do not throw", async () => {
  assert.deepEqual(drivers.ids(), ["page", "playwright", "adb"]);
  for (const id of drivers.ids()) {
    const a = await drivers.byId(id).available();
    assert.equal(typeof a.ok, "boolean");
    if (!a.ok) assert.match(a.why, /not (installed|on PATH)/, id);
  }
});
