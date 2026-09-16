// dotty/index.js — what the screen actually showed, and what a session should
// read instead of looking at it.
//
// `bb recom` keeps what a run ANSWERED. This keeps what it SHOWED, which is the
// other half of the same record: the prototype's canonical example was
// `evidence: ["dotty/out/<stamp>-<label>/"]`, and only one half of that pair
// made the port.
//
// The design decision that makes this worth building rather than shelling out
// to a screenshot tool:
//
//   **The PNG is for the human. The accessibility summary is for the session.**
//
// An image costs vision tokens and cannot be grepped, diffed or asserted on. The
// same screen as `{"role":"button","name":"Add to cart","disabled":true}` costs
// about a hundred tokens for a whole page, survives a CSS refactor, and can be
// compared with the shot taken ninety seconds ago. So every capture writes both,
// and the verb PRINTS the summary and merely names the file.
//
// Browser only, on purpose. Android capture is ARTEMIS's job — it already keeps
// timelines and video replays with a session clock, and `mobile_inspect_trace`
// fetches them, so an `adb exec-out screencap` here would be a worse second
// implementation. iOS and desktop have no cheap answer at all. The seam between
// them is a recom record: whatever took the picture, the record's `evidence`
// points at it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VAR, rel } from "../core/paths.js";
import { load } from "../core/config.js";
import { out, warn, emit } from "../core/log.js";
import { stamp, slug, pad, table, human } from "../core/util.js";
import { writeJson } from "../core/config.js";
import * as cdp from "./cdp.js";
import { inspect } from "./png.js";

export const DIR = () => path.join(VAR, "dotty");

const endpoint = (flags = {}) => {
  const cfg = load()?.dotty || {};
  return {
    host: String(flags.host || cfg.host || "127.0.0.1"),
    port: Number(flags.port || cfg.port || 9222),
  };
};

/** The interactive and structural nodes, which is what a scenario would assert
 *  on. Everything else in an accessibility tree is bookkeeping. */
const KEEP = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
  "option", "slider", "spinbutton", "switch", "tab", "menuitem", "heading", "alert", "status", "dialog", "progressbar"]);

function summarise(nodes) {
  const rows = [];
  for (const n of nodes || []) {
    const role = n.role?.value;
    const name = n.name?.value || "";
    if (!role || !KEEP.has(role)) continue;
    const props = Object.fromEntries((n.properties || [])
      .filter((p) => p?.value && "value" in p.value).map((p) => [p.name, p.value.value]));
    const row = { role, name: String(name).slice(0, 80) };
    const v = n.value?.value;
    if (v !== undefined && v !== "") row.value = String(v).slice(0, 40);
    for (const k of ["disabled", "checked", "expanded", "required", "invalid"]) {
      if (k in props && props[k] !== false && props[k] !== "false") row[k] = props[k];
    }
    rows.push(row);
  }
  return rows;
}

const SEP = String.fromCharCode(0);
const key = (r) => [r.role, r.name, r.disabled ? "disabled" : "", r.checked ?? "", r.value ?? ""].join(SEP);

/** What changed between two screens, as rows rather than as two images.
 *
 *  A MULTISET difference, not a set one. A product grid has ten identical
 *  `button "Add to cart"` nodes, and deduplicating them makes the one that
 *  became disabled invisible — the page would report "nothing changed" while
 *  showing something different. So rows are counted, and the diff is the
 *  difference between the counts.
 *
 *  This is the whole reason to keep the summary: a person compares pictures, a
 *  session cannot, and "one Add to cart stopped being disabled" is the fact
 *  either of them actually wanted. */
export function diff(before, after) {
  const count = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
      const k = key(r);
      const cur = m.get(k) || { row: r, n: 0 };
      cur.n += 1;
      m.set(k, cur);
    }
    return m;
  };
  const b = count(before), a = count(after);
  const appeared = [], gone = [];
  let same = 0;
  for (const [k, { row, n }] of a) {
    const was = b.get(k)?.n || 0;
    if (n > was) appeared.push({ ...row, n: n - was });
    same += Math.min(n, was);
  }
  for (const [k, { row, n }] of b) {
    const now = a.get(k)?.n || 0;
    if (n > now) gone.push({ ...row, n: n - now });
  }
  return { appeared, gone, same };
}

/** One capture. Writes the PNG and the summary beside each other and returns
 *  the summary, because that is the half anything downstream can use. */
export async function shot({ label = "shot", url = "", dir = null, flags = {} } = {}) {
  const { host, port } = endpoint(flags);
  const outDir = dir || path.join(DIR(), `${stamp()}-${slug(label)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const { session, target } = await cdp.attach({ host, port, url });
  try {
    await session.call("Page.enable");
    await session.call("Runtime.enable");
    if (url) {
      await session.call("Page.navigate", { url });
      // Wait for the page's OWN render, not for a load event. A single-page app
      // fetches after load, and a frame taken before that is a picture of an
      // empty list that is not blank and is not the screen either.
      const settleMs = Number(flags.settle) || 8000;
      const until = Date.now() + settleMs;
      for (;;) {
        const r = await session.call("Runtime.evaluate", {
          expression: "document.readyState === 'complete' && document.body && document.body.innerText.trim().length",
          returnByValue: true,
        }).catch(() => null);
        if (r?.result?.value) break;
        if (Date.now() > until) break;
        await new Promise((s) => setTimeout(s, 150));
      }
    }

    const png = await session.call("Page.captureScreenshot", { format: "png" }, { timeout: 30000 });
    const buf = Buffer.from(png.data, "base64");
    const file = path.join(outDir, `${slug(label)}.png`);
    fs.writeFileSync(file, buf);

    await session.call("Accessibility.enable");
    const ax = await session.call("Accessibility.getFullAXTree", {}, { timeout: 30000 });
    const screen = summarise(ax.nodes);

    const info = await session.call("Runtime.evaluate", {
      expression: "JSON.stringify({title: document.title, url: location.href, w: innerWidth, h: innerHeight})",
      returnByValue: true,
    }).catch(() => null);
    const meta = (() => { try { return JSON.parse(info.result.value); } catch { return {}; } })();

    const frame = inspect(buf);
    const row = {
      label, file: rel(file), at: new Date().toISOString(),
      title: meta.title ?? target.title, url: meta.url ?? target.url,
      viewport: meta.w ? `${meta.w}x${meta.h}` : "",
      blank: frame.blank, blank_why: frame.why, bytes: buf.length,
      nodes: screen.length, screen,
    };
    writeJson(path.join(outDir, `${slug(label)}.json`), row);
    return { ...row, dir: rel(outDir) };
  } finally { session.close(); }
}

/** The page, measured against the rows a machine can check.
 *
 *  Ported from spinwish's `mainboard/bugbash/sweep.spec.ts`, which ran the same
 *  six checks through Playwright. There is no Playwright here and installing one
 *  to ask whether an image has an `alt` would be the third browser this box
 *  drives; CCDP is already attached for the screenshot, so the checks run in the
 *  page it is attached to.
 *
 *  Everything below is a MEASUREMENT taken against a rendered screen, never a
 *  read of the source. That distinction is the mainboard's third rule and it is
 *  the reason this is worth the browser: a component that declares an `alt` prop
 *  and never passes it through reads correct and renders wrong.
 *
 *  The narrow pass is a separate measurement, not a guess from the wide one. A
 *  layout that fits at 1280 and overflows at 390 is the common case and the only
 *  one anybody ships by accident. */
export async function sweep({ url = "", label = "", dir = null, narrow = 390, flags = {} } = {}) {
  const { host, port } = endpoint(flags);
  const name = label || slug(url.replace(/^https?:\/\//, "")) || "sweep";
  const outDir = dir || path.join(DIR(), `${stamp()}-${slug(name)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const { session, target } = await cdp.attach({ host, port, url });
  const errors = [];
  // The navigated document's OWN response. `Page.navigate` resolves the same
  // way for a 200 and for a 404 — the browser rendered the server's error page,
  // which is a page — so without this a route that does not exist is measured
  // as though it were the product, and its failed main request was reported as
  // a missing subresource. Measured: `/selftest/states.html` against an API
  // base filed "asked for 1 file the server did not give it" instead of "this
  // route is a 404".
  let doc = null;
  try {
    // Listening BEFORE the navigation, because an exception thrown while the
    // page boots is the one worth catching and it is over before any call the
    // navigation returns from.
    session.onEvent = (method, params) => {
      // Everything observed before the new document commits belongs to the
      // PREVIOUS one. `cdp.attach` reuses the tab, so a timer left running by
      // the route swept a moment ago throws into this capture and the finding
      // names the wrong page — measured: a clean studio reported a TypeError
      // from the deliberately broken fixture swept before it. The main frame's
      // navigation is the line between the two documents, so it clears what was
      // collected up to that point.
      if (method === "Network.responseReceived" && params.type === "Document") {
        doc = { status: params.response?.status ?? null, url: params.response?.url || "", mime: params.response?.mimeType || "" };
        return;
      }
      if (method === "Page.frameNavigated" && !params.frame?.parentId) { errors.length = 0; return; }
      if (errors.length >= 40) return;
      if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails || {};
        errors.push({ kind: "exception", text: String(d.exception?.description || d.text || "").split("\n")[0].slice(0, 200) });
      } else if (method === "Log.entryAdded" && params.entry?.level === "error") {
        errors.push({ kind: params.entry.source || "log", text: String(params.entry.text || "").slice(0, 200), url: params.entry.url || "" });
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        errors.push({ kind: "console", text: (params.args || []).map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 200) });
      }
    };
    await session.call("Page.enable");
    await session.call("Runtime.enable");
    await session.call("Network.enable").catch(() => null);
    await session.call("Log.enable").catch(() => null);

    if (url) {
      await session.call("Page.navigate", { url });
      const until = Date.now() + (Number(flags.settle) || 8000);
      for (;;) {
        const r = await session.call("Runtime.evaluate", {
          expression: "document.readyState === 'complete' && document.body && document.body.innerText.trim().length",
          returnByValue: true,
        }).catch(() => null);
        if (r?.result?.value) break;
        if (Date.now() > until) break;
        await new Promise((s2) => setTimeout(s2, 150));
      }
    }

    const measured = await measure(session);
    const png = await session.call("Page.captureScreenshot", { format: "png" }, { timeout: 30000 });
    const buf = Buffer.from(png.data, "base64");
    const file = path.join(outDir, `${slug(name)}.png`);
    fs.writeFileSync(file, buf);

    // The narrow pass. The override is cleared in every exit path: a session
    // that leaves a device override behind hands the NEXT capture a 390px
    // browser nobody asked for, and that failure looks exactly like a
    // responsive bug in an unrelated screen.
    let narrowRow = null;
    try {
      await session.call("Emulation.setDeviceMetricsOverride", { width: narrow, height: 844, deviceScaleFactor: 0, mobile: true });
      await new Promise((s2) => setTimeout(s2, 400));
      narrowRow = await measure(session);
    } catch { /* an endpoint without Emulation reports the wide pass only */ }
    finally { await session.call("Emulation.clearDeviceMetricsOverride").catch(() => null); }

    await session.call("Accessibility.enable").catch(() => null);
    const ax = await session.call("Accessibility.getFullAXTree", {}, { timeout: 30000 }).catch(() => ({ nodes: [] }));
    const screen = summarise(ax.nodes);
    const frame = inspect(buf);

    const row = {
      label: name, url: measured.url || url || target.url, title: measured.title || target.title,
      file: rel(file), at: new Date().toISOString(),
      viewport: `${measured.innerW}x${measured.innerH}`, narrow_viewport: narrowRow ? `${narrow}x844` : "",
      status: doc ? doc.status : null, mime: doc ? doc.mime : "",
      blank: frame.blank, blank_why: frame.why, bytes: buf.length,
      wide: measured, narrow: narrowRow, errors, nodes: screen.length, screen,
    };
    writeJson(path.join(outDir, `${slug(name)}.json`), row);
    return { ...row, dir: rel(outDir) };
  } finally { session.onEvent = null; session.close(); }
}

/** One round trip, every mechanizable row. Kept as one expression because each
 *  extra `Runtime.evaluate` is a round trip against a page that may still be
 *  settling, and two of them can disagree about the same screen. */
async function measure(session) {
  const expr = `(() => {
    const out = {};
    const de = document.documentElement;
    out.url = location.href; out.title = document.title;
    out.viewportMeta = !!document.querySelector('meta[name=viewport]');
    out.innerW = window.innerWidth; out.innerH = window.innerHeight;
    out.scrollW = de ? de.scrollWidth : 0;
    out.overflow = out.scrollW - out.innerW;
    const body = document.body;
    out.text = body ? body.innerText.slice(0, 120000) : "";
    out.textLen = out.text.length;
    const imgs = Array.prototype.slice.call(document.images || []);
    out.images = imgs.length;
    out.noAlt = imgs.filter(i => !i.hasAttribute('alt'))
      .map(i => String(i.currentSrc || i.src || '').slice(-90)).slice(0, 10);
    out.noAltCount = imgs.filter(i => !i.hasAttribute('alt')).length;
    const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[onclick]';
    const nodes = Array.prototype.slice.call(document.querySelectorAll(SEL));
    out.interactive = nodes.length;
    const small = [], unlabelled = [];
    const labelOf = (n) => String(n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || n.value || '').trim();
    for (const n of nodes) {
      const b = n.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const label = labelOf(n);
      if (b.width < 44 || b.height < 44) small.push({ tag: n.tagName.toLowerCase(), label: label.slice(0, 40), w: Math.round(b.width), h: Math.round(b.height) });
      if (!label && !n.querySelector('img,svg') && !n.getAttribute('aria-labelledby')) {
        unlabelled.push({ tag: n.tagName.toLowerCase(), cls: String(n.getAttribute('class') || '').slice(0, 40) });
      }
    }
    out.smallCount = small.length; out.small = small.slice(0, 12);
    out.unlabelledCount = unlabelled.length; out.unlabelled = unlabelled.slice(0, 12);
    return JSON.stringify(out);
  })()`;
  const r = await session.call("Runtime.evaluate", { expression: expr, returnByValue: true }, { timeout: 20000 }).catch(() => null);
  try { return JSON.parse(r.result.value); } catch { return { url: "", title: "", viewportMeta: true, innerW: 0, innerH: 0, scrollW: 0, overflow: 0, text: "", textLen: 0, images: 0, noAlt: [], noAltCount: 0, interactive: 0, small: [], smallCount: 0, unlabelled: [], unlabelledCount: 0 }; }
}

const MARK = (b) => (b === true ? "BLANK" : b === null ? "UNCHECKED" : "ok");

function printShot(r) {
  out(`  ${pad(r.label, 16)} ${MARK(r.blank)}  ${r.viewport}  ${human(r.bytes)}B  ${r.file}`);
  if (r.blank === true) warn(`${r.label} is a picture of nothing: ${r.blank_why}`);
  if (r.blank === null) warn(`${r.label} could not be checked: ${r.blank_why}`);
  out(`  ${r.title || "(no title)"}  ${r.url || ""}`);
  if (!r.screen.length) { out("    nothing interactive on screen"); return; }
  out(table(r.screen.slice(0, 24).map((n) => [n.role, n.name, [n.value, n.disabled ? "disabled" : "", n.checked ? `checked=${n.checked}` : ""].filter(Boolean).join(" ")]),
    { header: ["role", "name", ""] }).split("\n").map((l) => "    " + l).join("\n"));
  if (r.screen.length > 24) out(`    … and ${r.screen.length - 24} more`);
}

async function cmd({ _, flags, rest }) {
  const sub = _[0] || "targets";
  const { host, port } = endpoint(flags);

  if (sub === "targets") {
    try {
      const v = await cdp.version({ host, port });
      const list = await cdp.targets({ host, port });
      if (flags.json) { emit({ ...v, targets: list }); return 0; }
      out(`  ${v.browser}  CDP ${v.protocol}  at ${host}:${port}`);
      if (!list.length) { out("  no page open"); return 0; }
      out(table(list.map((t) => [t.title.slice(0, 40), t.url.slice(0, 70)]), { header: ["title", "url"] })
        .split("\n").map((l) => "  " + l).join("\n"));
      return 0;
    } catch (e) {
      if (flags.json) { emit({ ok: false, why: e.message }); return 1; }
      warn(e.message);
      out(`\n  start one:  google-chrome --headless=new --remote-debugging-port=${port} about:blank`);
      out(`  or declare it in .bundlebox/runbook/services.json and \`bb runbook up --apply --wait\`.`);
      return 1;
    }
  }

  if (sub === "shot") {
    try {
      const r = await shot({ label: String(_[1] || flags.label || "shot"), url: String(flags.url || ""), flags });
      if (flags.json) { emit(r); return r.blank === true ? 1 : 0; }
      printShot(r);
      out(`\n  the summary above is what a session should read; the PNG is for a person.`);
      return r.blank === true ? 1 : 0;
    } catch (e) { warn(e.message); return 1; }
  }

  if (sub === "during") {
    const argv = rest || [];
    if (!argv.length) { warn("bb dotty during --label <name> -- <command>"); return 2; }
    const label = String(_[1] || flags.label || "during");
    const dir = path.join(DIR(), `${stamp()}-${slug(label)}`);
    let before, after;
    try { before = await shot({ label: "before", url: String(flags.url || ""), dir, flags }); }
    catch (e) { warn(`no frame before: ${e.message}`); return 1; }

    // The command's own output goes to a FILE, not the scrollback. A capture
    // run is usually long and noisy, and the point of keeping both halves is
    // that neither is read unless it is needed.
    const t0 = Date.now();
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const log = path.join(dir, "command.log");
    fs.writeFileSync(log, `$ ${argv.join(" ")}\n\n${r.stdout || ""}${r.stderr || ""}`);

    // Without --reload the after-frame is whatever the screen shows now, which
    // is right for a command that drove the browser itself. A command that
    // changed the SERVER leaves the page exactly as it was, and a diff of
    // nothing would read as "the change had no effect". --reload re-fetches the
    // same url so the second frame is about the new state.
    const again = flags.reload ? (before.url || String(flags.url || "")) : "";
    try { after = await shot({ label: "after", url: again, dir, flags }); }
    catch (e) { warn(`no frame after: ${e.message}`); }

    const d = after ? diff(before.screen, after.screen) : null;
    const res = { label, dir: rel(dir), command: argv.join(" "), rc: r.status ?? (r.error ? 127 : 1),
      ms: Date.now() - t0, log: rel(log), before, after: after || null, diff: d };
    if (flags.json) { emit(res); return res.rc; }

    out(`  ${res.command}   rc ${res.rc}   ${res.ms}ms   ${res.log}`);
    out("");
    printShot(before);
    if (after) { out(""); printShot(after); }
    if (d) {
      out(`\n  what changed: ${d.appeared.length} appeared, ${d.gone.length} gone, ${d.same} unchanged`);
      const line = (sign) => (n) => out(`    ${sign}  ${n.n > 1 ? `${n.n}x ` : ""}${pad(n.role, 12)} ${n.name}${n.disabled ? "  disabled" : ""}${n.checked ? `  checked=${n.checked}` : ""}`);
      d.appeared.slice(0, 10).forEach(line("+"));
      d.gone.slice(0, 10).forEach(line("-"));
      if (!d.appeared.length && !d.gone.length) out("    nothing on screen changed. If something was supposed to, that is the finding.");
    }
    return res.rc;
  }

  warn(`unknown dotty sub-verb: ${sub}. targets | shot [label] --url <u> | during [label] -- <cmd>`);
  return 2;
}

export const commands = {
  dotty: {
    help: "what the screen showed: a frame for a person, an accessibility summary for the session (0 model tokens)",
    usage: "bb dotty [targets | shot [label] --url <u> | during [label] [--reload] -- <cmd>] [--port 9222] [--json]",
    long: [
      "  bb dotty targets                          what pages the browser has open",
      "  bb dotty shot checkout --url http://…     one frame, plus what was on screen as rows",
      "  bb dotty during send -- npm run smoke     a frame each side of a command, and what changed",
      "  bb dotty during restock --reload -- curl …  re-fetch the page first, for a command that changed the server",
      "",
      "Browser only, over the Chrome DevTools Protocol, with no dependency. A frame that came back",
      "single-coloured is marked BLANK and the verb exits 1: a black rectangle filed as evidence is",
      "worse than no evidence. Point a recom record's `evidence` at the directory it writes.",
      "",
      "Android capture belongs to ARTEMIS, which already keeps traces: see `bb recom mobile`.",
    ].join("\n"),
    run: cmd,
  },
};
