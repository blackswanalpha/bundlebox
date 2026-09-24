// drivers.test.js — the three `ui` step drivers in src/cookbook/drivers/.
// page.js runs over real files in a tmp dir; adb.js runs against a fake `adb`
// on PATH that answers `uiautomator dump` and logs taps; playwright.js's `act`
// runs against a stub page, because a browser is not on every box.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-drivers-")));
const w = (rel, s, mode) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); if (mode) fs.chmodSync(p, mode); return p; };

const drivers = await import("../src/cookbook/drivers/index.js");
const page = await import("../src/cookbook/drivers/page.js");
const adb = await import("../src/cookbook/drivers/adb.js");
const playwright = await import("../src/cookbook/drivers/playwright.js");

test("drivers/index: a driver is looked up by id and never guessed", () => {
  assert.deepEqual(drivers.ids(), ["page", "playwright", "adb"]);
  assert.equal(drivers.byId("page"), drivers.DRIVERS.page);
  assert.equal(drivers.byId("selenium"), null);
  assert.equal(drivers.byId(undefined), null);
});

test("page.matches: id, class, tag and attribute selectors, alone and combined", () => {
  const el = { tag: "input", attrs: { id: "email", class: "field wide", name: "email", required: "" } };
  for (const s of ["#email", ".wide", "input", "input#email", "input.field.wide", "[name=email]", '[name="email"]', "[required]"]) assert.ok(page.matches(el, s), s);
  for (const s of ["#other", ".narrow", "button", "[name=pw]", "[disabled]", "div > input"]) assert.equal(page.matches(el, s), false, s);
});

test("page: open, visible/hidden/absent, text, type and a followed link", async () => {
  w("index.html", `<html><body><h1>Checkout</h1>
<form><input id="email" name="email"><input id="token" type="hidden"><div id="gone" style="color:red; display: none">x</div>
<span id="aria" aria-hidden="true">y</span><button class="pay">Pay now</button></form>
<a id="terms" href="terms.html">terms</a><a id="dead" href="missing.html">dead</a><a id="ext" href="https://example.com">ext</a>
<script>document.write("not text")</script></body></html>`);
  w("terms.html", "<p>The terms</p>");
  const s = await page.open({ root: tmp });
  assert.match((await page.act(s, { what: "text", text: "x" })).why, /no page is open/);
  const o = await page.act(s, { verb: "open", target: "./index.html" });
  assert.equal(o.ok, true);
  assert.equal(o.got.page, "index.html");

  assert.equal((await page.act(s, { what: "visible", selector: "#email" })).ok, true);
  for (const sel of ["#token", "#gone", "#aria"]) assert.match((await page.act(s, { what: "visible", selector: sel })).why, /hidden/, sel);
  assert.match((await page.act(s, { what: "visible", selector: "#nope" })).why, /nothing matches/);
  assert.equal((await page.act(s, { what: "absent", selector: "#gone" })).ok, true, "hidden counts as absent");
  assert.match((await page.act(s, { what: "absent", selector: ".pay" })).why, /expected absent/);

  assert.equal((await page.act(s, { what: "text", text: "Pay now" })).ok, true);
  assert.equal((await page.act(s, { what: "text", text: "not text" })).ok, false, "script bodies are not page text");

  assert.equal((await page.act(s, { verb: "type", selector: "#email", text: "a@b.c" })).ok, true);
  assert.deepEqual(s.typed, { "#email": "a@b.c" });
  assert.match((await page.act(s, { verb: "type", selector: ".pay", text: "x" })).why, /<button>, which takes no typing/);

  assert.deepEqual((await page.act(s, { verb: "click", selector: "#ext" })).got, { clicked: "#ext", tag: "a" }, "an external link is not followed");
  assert.match((await page.act(s, { verb: "click", selector: "#dead" })).why, /follows missing\.html, which does not open/);
  assert.match((await page.act(s, { verb: "click", selector: "#nope" })).why, /nothing matches/);
  assert.deepEqual((await page.act(s, { verb: "click", selector: "#terms" })).got, { followed: "terms.html" });
  assert.equal((await page.act(s, { what: "text", text: "The terms" })).ok, true);
  assert.equal((await page.act(s, { verb: "open", target: "none.html" })).ok, false);
});

test("adb: taps the centre of a resource id's bounds and reads the screen as text", { skip: process.platform === "win32" }, async () => {
  const log = path.join(tmp, "adb.log");
  const bin = path.join(tmp, "bin");
  w("bin/adb", `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *"uiautomator dump"*) echo '<hierarchy><node text="Hello" resource-id="com.app:id/login" bounds="[10,20][30,60]" /><node resource-id="com.app:id/nobounds" /></hierarchy>' ;;
  *"am start"*"bad/"*) echo "Error: no activity" >&2; exit 1 ;;
esac
exit 0
`, 0o755);
  const PATH = process.env.PATH;
  const serial = process.env.BB_ADB_SERIAL;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  process.env.BB_ADB_SERIAL = "emu-1";
  try {
    assert.equal(adb.available().ok, true);
    const s = await adb.open({}, "com.app/.Main");
    assert.equal(s.serial, "emu-1");
    assert.deepEqual(await adb.act(s, { verb: "click", selector: "#login" }), { ok: true, got: { tapped: "#login" } });
    assert.deepEqual(await adb.act(s, { verb: "type", selector: "login", text: "a b" }), { ok: true, got: { typed: "login" } });
    assert.match((await adb.act(s, { verb: "click", selector: "nobounds" })).why, /no bounds to tap/);
    assert.match((await adb.act(s, { verb: "click", selector: "missing" })).why, /no node with resource-id/);
    assert.deepEqual(await adb.act(s, { what: "visible", selector: "login" }), { ok: true, got: { bounds: [20, 40] } });
    assert.match((await adb.act(s, { what: "absent", selector: "login" })).why, /expected absent/);
    assert.equal((await adb.act(s, { what: "text", text: "Hello" })).ok, true);
    assert.equal((await adb.act(s, { what: "text", text: "Bye" })).ok, false);
    assert.match((await adb.act(s, { verb: "open", target: "bad/.X" })).why, /am start bad\/\.X: Error: no activity/);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls[0], "-s emu-1 shell am start -n com.app/.Main", "a component is started with -n");
    assert.ok(calls.includes("-s emu-1 shell input tap 20 40"));
    assert.ok(calls.includes("-s emu-1 shell input text a%sb"), "spaces are escaped for input text");
    assert.equal(await adb.act(s, { verb: "open", target: "https://x.test/a" }).then((r) => r.ok), true);
    assert.match(fs.readFileSync(log, "utf8"), /am start -a android\.intent\.action\.VIEW -d https:\/\/x\.test\/a/);
  } finally {
    process.env.PATH = PATH;
    if (serial === undefined) delete process.env.BB_ADB_SERIAL; else process.env.BB_ADB_SERIAL = serial;
  }
});

test("playwright: act maps each verb onto the page and reports a failure as a reason", async () => {
  const calls = [];
  const stub = (count, visible, body = "Welcome back") => ({
    goto: async (u) => { calls.push(["goto", u]); }, url: () => "http://app.test/login",
    click: async (sel) => { if (sel === "#boom") throw new Error("Timeout 5000ms exceeded\nmore"); calls.push(["click", sel]); },
    fill: async (sel, t) => { calls.push(["fill", sel, t]); },
    textContent: async () => body,
    locator: () => ({ count: async () => count, first: () => ({ isVisible: async () => visible }) }),
  });
  const s = { page: stub(1, true), base: "http://app.test/" };
  assert.deepEqual(await playwright.act(s, { verb: "open", target: "login" }), { ok: true, got: { url: "http://app.test/login" } });
  await playwright.act(s, { verb: "open", target: "file:///x.html" });
  assert.deepEqual(calls.filter((c) => c[0] === "goto").map((c) => c[1]), ["http://app.test/login", "file:///x.html"]);
  assert.deepEqual(await playwright.act(s, { verb: "click", selector: "#go" }), { ok: true, got: { clicked: "#go" } });
  assert.deepEqual(await playwright.act(s, { verb: "click", selector: "#boom" }), { ok: false, why: "Timeout 5000ms exceeded" });
  assert.deepEqual(await playwright.act(s, { verb: "type", selector: "#u", text: "me" }), { ok: true, got: { typed: "#u" } });
  assert.equal((await playwright.act(s, { what: "text", text: "Welcome" })).ok, true);
  assert.match((await playwright.act(s, { what: "text", text: "Bye" })).why, /does not contain "Bye"/);
  assert.deepEqual(await playwright.act(s, { what: "visible", selector: "#u" }), { ok: true, got: { matched: 1 } });
  assert.match((await playwright.act(s, { what: "absent", selector: "#u" })).why, /visible, expected absent/);
  assert.match((await playwright.act({ page: stub(1, false) }, { what: "visible", selector: "#u" })).why, /in the page but not visible/);
  assert.match((await playwright.act({ page: stub(0, false) }, { what: "visible", selector: "#u" })).why, /nothing matches/);
  assert.equal((await playwright.act({ page: stub(0, false) }, { what: "absent", selector: "#u" })).ok, true);
  await playwright.close(null);
  await playwright.close({ browser: { close: async () => { throw new Error("gone"); } } });
});

test("playwright: open refuses with the reason when the module is not installed", async () => {
  const a = await playwright.available();
  if (a.ok) return;  // installed on this box: nothing to refuse
  assert.match(a.why, /playwright is not installed/);
  await assert.rejects(() => playwright.open({ base: "http://x" }, "/"), /playwright is not installed/);
});
