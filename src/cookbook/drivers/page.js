// drivers/page.js — a local HTML file, driven with no browser and no dependency.
//
// The narrow driver, and the one the suite runs on: a static page, read off
// disk, with elements matched by id, class, tag or attribute. It cannot run
// script, so what it proves is what the markup states — the field is there, the
// button is there, the text is there — which is exactly the claim a scenario
// derived from a document makes about a page it has never seen.
//
// `click` and `type` are recorded against the session rather than executed: a
// file has no event loop. A click on an `<a href>` follows the link, because a
// page whose links go nowhere is the one defect a static read can prove.
import fs from "node:fs";
import path from "node:path";

export const id = "page";
export const available = () => ({ ok: true });

const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\/?>/g;
// The value is optional: `hidden` and `disabled` carry their meaning by being
// there at all, and an attribute parser that only sees `k="v"` cannot tell a
// hidden element from a visible one.
const ATTR = /([:@a-zA-Z_][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;

/** Every element in the page as `{ tag, attrs, at }`. A parse, not a DOM: this
 *  driver asserts over markup and has no business running any of it. */
function elements(html) {
  const out = [];
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const attrs = {};
    ATTR.lastIndex = 0;
    for (let a = ATTR.exec(m[2] || ""); a; a = ATTR.exec(m[2] || "")) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? "";
    out.push({ tag: m[1].toLowerCase(), attrs, at: m.index });
  }
  return out;
}

/** `#id`, `.class`, `tag`, `[name=x]`, and `tag#id` / `tag.class` together. */
export function matches(el, selector) {
  const s = String(selector).trim();
  const parts = s.match(/^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/);
  if (!parts) return false;
  if (parts[1] && el.tag !== parts[1].toLowerCase()) return false;
  for (const p of parts[2].match(/[#.][\w-]+|\[[^\]]+\]/g) || []) {
    if (p[0] === "#") { if (el.attrs.id !== p.slice(1)) return false; }
    else if (p[0] === ".") { if (!String(el.attrs.class || "").split(/\s+/).includes(p.slice(1))) return false; }
    else {
      const kv = /^\[([\w:-]+)(?:\s*=\s*"?([^"\]]*)"?)?\]$/.exec(p);
      if (!kv) return false;
      const have = el.attrs[kv[1].toLowerCase()];
      if (have === undefined) return false;
      if (kv[2] !== undefined && have !== kv[2]) return false;
    }
  }
  return true;
}

// Hidden is what the markup says is hidden. A page driver that claimed to know
// computed visibility would be claiming to have run the CSS.
const hidden = (el) => el.attrs.hidden !== undefined || /(^|;)\s*display\s*:\s*none/i.test(el.attrs.style || "")
  || el.attrs.type === "hidden" || el.attrs["aria-hidden"] === "true";

const text = (html) => html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function load(session, target) {
  const file = path.resolve(session.root, target.replace(/^\.?\//, ""));
  const html = fs.readFileSync(file, "utf8");
  session.file = file;
  session.html = html;
  session.els = elements(html);
  session.text = text(html);
  return session;
}

export async function open({ root = process.cwd() } = {}, target) {
  const s = { root, file: "", html: "", els: [], text: "", typed: {}, clicked: [] };
  return target ? load(s, target) : s;
}

export async function act(s, a) {
  if (a.verb === "open") {
    try { load(s, a.target); return { ok: true, got: { page: path.relative(s.root, s.file), elements: s.els.length } }; }
    catch (e) { return { ok: false, why: `open ${a.target}: ${e.message}` }; }
  }
  if (!s.file) return { ok: false, why: "no page is open; the first `ui` step must be `open <path>`" };
  const found = a.selector ? s.els.filter((el) => matches(el, a.selector)) : [];
  if (a.verb === "click") {
    if (!found.length) return { ok: false, why: `nothing matches \`${a.selector}\``, got: { page: path.relative(s.root, s.file) } };
    s.clicked.push(a.selector);
    const href = found[0].attrs.href;
    // A link is the one action a file can really take.
    if (href && !/^(https?:|mailto:|#)/i.test(href)) {
      try { load(s, href); } catch (e) { return { ok: false, why: `clicking \`${a.selector}\` follows ${href}, which does not open: ${e.message}` }; }
      return { ok: true, got: { followed: href } };
    }
    return { ok: true, got: { clicked: a.selector, tag: found[0].tag } };
  }
  if (a.verb === "type") {
    if (!found.length) return { ok: false, why: `nothing matches \`${a.selector}\`` };
    if (!["input", "textarea", "select"].includes(found[0].tag) && found[0].attrs.contenteditable === undefined)
      return { ok: false, why: `\`${a.selector}\` is a <${found[0].tag}>, which takes no typing` };
    s.typed[a.selector] = a.text;
    return { ok: true, got: { typed: a.selector } };
  }
  if (a.what === "text") {
    return s.text.includes(a.text) ? { ok: true, got: {} }
      : { ok: false, why: `the page does not contain ${JSON.stringify(a.text)}`, got: { page_text: s.text.slice(0, 240) } };
  }
  const visible = found.filter((el) => !hidden(el));
  if (a.what === "visible") return visible.length ? { ok: true, got: { matched: visible.length } }
    : { ok: false, why: found.length ? `\`${a.selector}\` is in the page but hidden` : `nothing matches \`${a.selector}\`` };
  return visible.length ? { ok: false, why: `\`${a.selector}\` is present (${visible.length}), expected absent` } : { ok: true, got: {} };
}

export async function close() { /* a file holds nothing open */ }
