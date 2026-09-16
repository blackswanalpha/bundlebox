// bugbash.test.js — the judgement over one rendered screen. `judge` is pure, so
// every row the port brought over is tested without a browser; what needs Chrome
// is `dotty.sweep`, which produces the row this reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, routesFrom } from "../src/mainboard/bugbash.js";

const pass = { url: "http://x/a", title: "A", viewportMeta: true, innerW: 1280, innerH: 800, scrollW: 1280, overflow: 0,
  text: "hello", textLen: 5, images: 2, noAlt: [], noAltCount: 0, interactive: 4,
  small: [], smallCount: 0, unlabelled: [], unlabelledCount: 0 };
const row = (over = {}) => ({ label: "home", url: "http://x/a", file: ".bundlebox/var/dotty/x/home.png",
  status: 200, mime: "text/html", blank: false, errors: [], nodes: 4,
  wide: { ...pass }, narrow: { ...pass, innerW: 390, scrollW: 390 }, ...over });
const ids = (r) => r.findings.map((f) => f.id);

test("a clean screen files nothing", () => {
  const r = judge(row());
  assert.deepEqual(r.findings, []);
  assert.equal(r.facts.judged, true);
});

test("a capture with no screenshot is not judged, because a finding would have no evidence", () => {
  const r = judge(row({ file: null }));
  assert.deepEqual(r.findings, []);
  assert.equal(r.facts.judged, false);
  assert.match(r.facts.why, /screenshot/);
});

test("a route that answered 404 is filed as that, and nothing below it is measured", () => {
  const r = judge(row({ status: 404, wide: { ...pass, overflow: 300, noAltCount: 9, text: "Not Found" } }));
  assert.deepEqual(ids(r), ["BB-home-status"]);
  assert.equal(r.findings[0].category, "STATE");
  assert.equal(r.findings[0].severity, "high");
  assert.equal(r.facts.status, 404);
});

test("a route with no recorded status is still judged, because the browser may not have said", () => {
  assert.deepEqual(ids(judge(row({ status: null }))), []);
});

test("a blank screen is filed once and stops the other rows", () => {
  const r = judge(row({ blank: true, blank_why: "one colour", wide: { ...pass, overflow: 200, noAltCount: 3 } }));
  assert.deepEqual(ids(r), ["BB-home-blank"]);
  assert.equal(r.findings[0].category, "STATE");
  assert.equal(r.facts.blank, true);
});

test("overflow at the phone width and at desktop are two different findings", () => {
  const both = judge(row({ wide: { ...pass, scrollW: 1400, overflow: 120 }, narrow: { ...pass, innerW: 390, scrollW: 500, overflow: 110 } }));
  assert.deepEqual(ids(both).sort(), ["BB-home-overflow-narrow", "BB-home-overflow-wide"]);
  const phoneOnly = judge(row({ narrow: { ...pass, innerW: 390, scrollW: 500, overflow: 110 } }));
  assert.deepEqual(ids(phoneOnly), ["BB-home-overflow-narrow"]);
  assert.match(phoneOnly.findings[0].detail, /nobody testing on a laptop will see it/);
  assert.equal(phoneOnly.findings[0].severity, "high");
});

test("a page with no viewport meta says so, because the phone pass measured a desktop layout", () => {
  const r = judge(row({ wide: { ...pass, viewportMeta: false } }));
  assert.deepEqual(ids(r), ["BB-home-viewport-meta"]);
  assert.match(r.findings[0].detail, /980px/);
  assert.deepEqual(ids(judge(row())), [], "a page that declares one files nothing");
});

test("a tap target under the floor is measured at the phone width only", () => {
  const small = { ...pass, innerW: 390, smallCount: 2, interactive: 9, small: [{ tag: "button", label: "x", w: 24, h: 24 }] };
  const r = judge(row({ wide: { ...pass, smallCount: 5 }, narrow: small }));
  assert.deepEqual(ids(r), ["BB-home-tap"]);
  assert.equal(r.findings[0].evidence.under_floor, 2, "the wide pass does not contribute a touch finding");
});

test("a tap target the declaration passed is raised and handed to designlabs", () => {
  const small = { ...pass, innerW: 390, smallCount: 1, interactive: 9, small: [{ tag: "a", label: "y", w: 20, h: 20 }] };
  const clean = judge(row({ narrow: small }));
  assert.equal(clean.findings[0].severity, "medium");
  assert.equal(clean.findings[0].refers, "");
  const contradicted = judge(row({ narrow: small }), { declared: { "target.min-size": "pass" } });
  assert.equal(contradicted.findings[0].severity, "high");
  assert.equal(contradicted.findings[0].refers, "designlabs");
  assert.match(contradicted.findings[0].detail, /disagree/);
});

test("images with no alt and controls with no name are separate rows", () => {
  const r = judge(row({ wide: { ...pass, noAltCount: 2, noAlt: ["a.png", "b.png"], unlabelledCount: 1, unlabelled: [{ tag: "button", cls: "icon" }] } }));
  assert.deepEqual(ids(r).sort(), ["BB-home-alt", "BB-home-unlabelled"]);
  assert.equal(r.findings.find((f) => f.id.endsWith("alt")).category, "A11Y");
  assert.equal(r.findings.find((f) => f.id.endsWith("unlabelled")).severity, "high");
});

test("banned copy is found in the rendered text with its context", () => {
  const r = judge(row({ wide: { ...pass, text: "All sales are final. Ask about a refund anytime." } }), { banned: ["refund"] });
  assert.deepEqual(ids(r), ["BB-home-copy"]);
  assert.equal(r.findings[0].category, "COPY");
  assert.equal(r.findings[0].severity, "high");
  assert.match(r.findings[0].evidence.hits[0].context, /refund/);
});

test("the banned list is empty by default, so no default word is ever accused", () => {
  assert.deepEqual(judge(row({ wide: { ...pass, text: "refund service fee money back" } })).findings, []);
});

test("an error thrown during load is a finding about the part that did not run", () => {
  const r = judge(row({ errors: [{ kind: "exception", text: "TypeError: x is not a function" }] }));
  assert.deepEqual(ids(r), ["BB-home-console"]);
  assert.match(r.findings[0].detail, /TypeError/);
  assert.equal(r.findings[0].severity, "high");
});

test("a missing favicon is not a page that threw, and is not filed at all", () => {
  const fav = judge(row({ errors: [{ kind: "network", text: "404", url: "http://x/favicon.ico" }] }));
  assert.deepEqual(ids(fav), [], "the one request every browser makes and no server serves");
  const css = judge(row({ errors: [{ kind: "network", text: "404", url: "http://x/app.css" }] }));
  assert.deepEqual(ids(css), ["BB-home-subresource"]);
  assert.equal(css.findings[0].severity, "medium", "a missing file ranks below code that did not run");
});

test("a thrown error and a missing file are two rows, not one", () => {
  const r = judge(row({ errors: [
    { kind: "exception", text: "boom" },
    { kind: "network", text: "404", url: "http://x/app.js" },
    { kind: "network", text: "404", url: "http://x/favicon.ico" },
  ] }));
  assert.deepEqual(ids(r).sort(), ["BB-home-console", "BB-home-subresource"]);
  assert.equal(r.findings.find((f) => f.id.endsWith("console")).evidence.count, 1);
  assert.equal(r.findings.find((f) => f.id.endsWith("subresource")).evidence.count, 1);
});

test("routes are joined to the base and never invented", () => {
  assert.deepEqual(routesFrom({ routes: ["/a", { path: "/b", label: "bee" }] }, "http://h:1/"),
    [{ label: "a", url: "http://h:1/a" }, { label: "bee", url: "http://h:1/b" }]);
  assert.deepEqual(routesFrom({ routes: ["http://other/x"] }, ""), [{ label: "x", url: "http://other/x" }],
    "an absolute URL is labelled by its path, because the label becomes the finding key");
  assert.deepEqual(routesFrom({ routes: ["http://other/"] }, ""), [{ label: "root", url: "http://other/" }]);
  assert.deepEqual(routesFrom({}, "http://h:1"), [], "no declaration, no route");
  assert.deepEqual(routesFrom({ routes: ["/a"] }, ""), [], "a relative path with no base is not a URL to guess at");
});
