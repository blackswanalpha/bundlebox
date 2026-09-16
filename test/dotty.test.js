// dotty.test.js — the two claims that make a capture worth filing.
//
//   1. A frame that is a picture of nothing says so.
//   2. What changed between two screens is a MULTISET difference, because a
//      product grid has ten identical buttons and the one that changed is the
//      whole point.
//
// The CDP half needs a browser and skips by name when there is not one. The
// PNG and diff halves need nothing, so they run everywhere — which matters,
// because they are the two that can be silently wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { inspect, chunks } from "../src/dotty/png.js";
import { diff } from "../src/dotty/index.js";

/** A real PNG, assembled here so the decoder is tested against bytes rather
 *  than against a fixture nobody can read. CRC is left zero on purpose: the
 *  parser under test does not verify it, and pretending otherwise would be a
 *  test of this helper. */
function png(width, height, pixel, { filter = 0, vary = false } = {}) {
  const ch = pixel.length;
  // The intended image first, then the filter applied to it. Writing the raw
  // values and merely LABELLING them filtered would test nothing: the decoder
  // would reverse a filter that was never applied, and the test would fail
  // against a correct decoder.
  const rowBytes = width * ch;
  const img = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < ch; k++) {
        img[y * rowBytes + x * ch + k] =
          vary && x === (width >> 1) && y === (height >> 1) ? (pixel[k] ^ 0xff) : pixel[k];
      }
    }
  }
  const raw = Buffer.alloc((rowBytes + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const v = img[y * rowBytes + x];
      const a = x >= ch ? img[y * rowBytes + x - ch] : 0;      // Sub
      const b = y ? img[(y - 1) * rowBytes + x] : 0;           // Up
      raw[o++] = filter === 0 ? v : filter === 1 ? (v - a) & 0xff : filter === 2 ? (v - b) & 0xff : v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = ch === 4 ? 6 : ch === 3 ? 2 : 0;
  const chunk = (type, data) => Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(data.length); return b; })(),
    Buffer.from(type, "latin1"), data, Buffer.alloc(4),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a single-coloured frame is BLANK and says which colour", () => {
  const r = inspect(png(64, 48, [255, 255, 255]));
  assert.equal(r.blank, true);
  assert.equal(r.width, 64);
  assert.equal(r.height, 48);
  assert.match(r.why, /255,255,255/);

  const black = inspect(png(64, 48, [0, 0, 0]));
  assert.equal(black.blank, true, "screencap returning a black image is the failure this exists for");
});

test("a frame with one different pixel is not blank", () => {
  const r = inspect(png(64, 48, [255, 255, 255], { vary: true }), { sample: 1 << 20 });
  assert.equal(r.blank, false);
  assert.equal(r.colour, null);
});

test("the scanline filters are reversed before the pixels are compared", () => {
  // Filter 1 (Sub) turns a flat region into a run of zero bytes. A decoder that
  // skipped unfiltering would call this frame blank whatever is in it, and
  // would call a varying frame blank too — the bug that makes every screenshot
  // look like a picture of nothing.
  const flat = inspect(png(64, 48, [12, 34, 56], { filter: 1 }));
  assert.equal(flat.blank, true);
  assert.match(flat.why, /12,34,56/, "the colour is the real one, not the filtered bytes");

  const varied = inspect(png(64, 48, [12, 34, 56], { filter: 1, vary: true }), { sample: 1 << 20 });
  assert.equal(varied.blank, false);
});

test("a frame nobody could check is `null`, never `false`", () => {
  // Null is not false, for the same reason `unknown` is not `fresh`: a frame
  // the instrument could not read must not be reported as a frame that was fine.
  assert.equal(inspect(Buffer.from("not a png at all")).blank, null);
  assert.equal(chunks(Buffer.from("nope")), null);

  const interlaced = png(8, 8, [1, 2, 3]);
  interlaced[8 + 8 + 12] = 1; // IHDR interlace byte
  const r = inspect(interlaced);
  assert.equal(r.blank, null);
  assert.match(r.why, /interlaced/);
});

test("what changed is a multiset difference, so one of ten identical buttons still shows", () => {
  const grid = (n, disabled = 0) => [
    ...Array.from({ length: n - disabled }, () => ({ role: "button", name: "Add to cart" })),
    ...Array.from({ length: disabled }, () => ({ role: "button", name: "Add to cart", disabled: true })),
  ];
  const d = diff(grid(10, 1), grid(10, 0));
  assert.equal(d.same, 9);
  assert.equal(d.appeared.length, 1);
  assert.equal(d.gone.length, 1);
  assert.equal(d.gone[0].disabled, true, "the one that stopped being disabled is named");
  assert.equal(d.appeared[0].n, 1);

  // A set difference would report this as no change at all.
  assert.notDeepEqual(d.appeared, [], "ten identical rows must not collapse to one");
});

test("two identical screens differ by nothing", () => {
  const screen = [{ role: "button", name: "Search" }, { role: "heading", name: "Catalogue" }];
  const d = diff(screen, screen);
  assert.deepEqual(d.appeared, []);
  assert.deepEqual(d.gone, []);
  assert.equal(d.same, 2);
});

test("a value or a checked state counts as a different row", () => {
  const d = diff([{ role: "textbox", name: "Postcode", value: "" }], [{ role: "textbox", name: "Postcode", value: "00100" }]);
  assert.equal(d.appeared.length, 1);
  assert.equal(d.gone.length, 1);
  assert.equal(d.same, 0);
});

test("a capture against a real browser returns a summary, not an image", async (t) => {
  const cdp = await import("../src/dotty/cdp.js");
  const reachable = await cdp.version({ port: 9222, timeout: 1500 }).catch(() => null);
  if (!reachable) return t.skip("no CDP endpoint on 9222");

  const { shot } = await import("../src/dotty/index.js");
  const r = await shot({ label: "blank-probe", url: "about:blank" });
  assert.equal(r.blank, true, "about:blank is a picture of nothing and must be marked so");
  assert.ok(r.file.endsWith(".png"));
  assert.ok(Array.isArray(r.screen));
});

// ── the event channel ───────────────────────────────────────────────────────
//
// A CDP message with no `id` is an event, and the session dropped every one of
// them. That is the silent half: `Page.captureScreenshot` is a call and worked,
// so nothing failed — there was simply no way to observe a console error, and
// "this page throws while it loads" was invisible rather than reported. Needs no
// browser: the routing is the thing that was wrong.
import { Session } from "../src/dotty/cdp.js";

const fakeWs = () => { const ws = { sent: [], onMessage: null, send(m) { this.sent.push(m); }, close() { this.closed = true; } }; return ws; };

test("an event reaches the listener and a reply does not", async () => {
  const ws = fakeWs();
  const s = new Session(ws);
  const seen = [];
  s.onEvent = (method, params) => seen.push([method, params]);

  const p = s.call("Page.navigate", { url: "http://x" });
  ws.onMessage({ method: "Page.frameNavigated", params: { frame: { url: "http://x" } } });
  ws.onMessage({ id: ws.sent[0].id, result: { frameId: "1" } });

  assert.deepEqual(await p, { frameId: "1" });
  assert.equal(seen.length, 1, "the reply is not delivered as an event");
  assert.equal(seen[0][0], "Page.frameNavigated");
  assert.equal(seen[0][1].frame.url, "http://x");
  s.close();
});

test("a listener that throws does not take the session down", async () => {
  const ws = fakeWs();
  const s = new Session(ws);
  s.onEvent = () => { throw new Error("listener is broken"); };
  assert.doesNotThrow(() => ws.onMessage({ method: "Log.entryAdded", params: {} }));
  const p = s.call("Runtime.evaluate", {});
  ws.onMessage({ id: ws.sent[0].id, result: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 }, "calls still resolve after a listener threw");
  s.close();
});

test("with no listener an event is dropped, exactly as before", () => {
  const ws = fakeWs();
  const s = new Session(ws);
  assert.doesNotThrow(() => ws.onMessage({ method: "Log.entryAdded", params: {} }));
  s.close();
});
