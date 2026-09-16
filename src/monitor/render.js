// monitor/render.js — the presentation layer for `bb monitor`.
//
// Every number `bb monitor` prints was already measured elsewhere. This file
// decides only how a person READS them, and it is separate from the maths for
// one reason: the reports used to be written by whoever added the number, so a
// reader met `exhausts_first`, `p90` and `[##----]` in the same eight lines and
// had to know the implementation to know what was wrong.
//
// Three rules hold the layout together:
//   1. The headline is a sentence, not a field. The first line says what is
//      true; the table underneath says how it was worked out.
//   2. Colour is a second channel, never the only one. Strip every escape and
//      the report still says the same thing, because state is also a word.
//   3. A label is what a reader would call it. "spending", not "burn".
import { clamp } from "../core/util.js";

// ── colour ──────────────────────────────────────────────────────────────────
// 256-colour, because truecolour buys nothing at this palette size and 16
// colours are whatever the user's theme says they are. Roles, not colours: the
// call site asks for "good", so the palette can be retuned in one place.
const INK = { ink: 252, mute: 245, faint: 240, good: 78, warn: 214, bad: 203, cool: 111, gold: 179, accent: 141 };
const BOLD = "\x1b[1m", RESET = "\x1b[0m";

let forced = null;
/** Turn colour off for a run (`--no-color`) or on for a test. */
export const setColor = (on) => { forced = on; };
export function coloured() {
  if (forced != null) return forced;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

export function paint(s, role, { bold = false } = {}) {
  if (!coloured() || !INK[role]) return bold && coloured() ? `${BOLD}${s}${RESET}` : String(s);
  return `\x1b[38;5;${INK[role]}m${bold ? BOLD : ""}${s}${RESET}`;
}
export const dim = (s) => paint(s, "faint");
export const mute = (s) => paint(s, "mute");

// ── meters ──────────────────────────────────────────────────────────────────
// Eighth-width blocks so a 3% reading is a sliver rather than an empty bar. A
// meter with nothing to measure is drawn faint and empty, never at zero: zero
// is a measurement and "no limit established" is not one.
const EIGHTH = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const PER_CELL = 8;

export function meter(pct, { width = 24, role = "good" } = {}) {
  if (pct == null) return dim("╌".repeat(width));
  const cells = clamp((pct / 100) * width, 0, width);
  const full = Math.floor(cells);
  const part = EIGHTH[Math.round((cells - full) * PER_CELL)] || "";
  const drawn = "█".repeat(full) + part;
  return paint(drawn, role) + dim("░".repeat(Math.max(0, width - drawn.length)));
}

/** The role a percentage should be drawn in. Matches the state words exactly,
 *  so the colour never disagrees with the text next to it. */
export const roleFor = (state) => ({ hit: "bad", near: "warn", ok: "good", indeterminate: "faint" })[state] || "mute";

// ── layout ──────────────────────────────────────────────────────────────────
const PAD = "  ";
const LABEL_W = 14;
const VALUE_W = 10;

/** A report's masthead: what you are looking at, and which workspace it read. */
export function masthead(title, place) {
  const left = `${paint("bundlebox", "accent", { bold: true })} ${dim("·")} ${mute(title)}`;
  return `\n${PAD}${left}${place ? `   ${dim(place)}` : ""}\n`;
}

/** The one sentence a reader came for, in the state's own colour. */
export const headline = (text, role = "ink") => `${PAD}${paint(text, role, { bold: true })}`;

/** `label   value   note` — the note is dim because it is provenance, not news.
 *  The value column is padded on its PRINTED width, so a coloured figure sits
 *  in the same column as a plain one and the notes read as a paragraph. */
export function row(label, value, note = "", { width = VALUE_W } = {}) {
  const l = mute(fit(String(label).slice(0, LABEL_W - 1), LABEL_W));
  const v = fit(value, width);
  return `${PAD}${l}${v}${note ? `   ${dim(note)}` : ""}`;
}

export const section = (name) => `\n${PAD}${mute(name.toUpperCase())}\n${PAD}${dim("─".repeat(Math.max(name.length, 44)))}`;

/** A footnote: what the reader should not conclude from the numbers above. */
export const note = (lines) => "\n" + lines.map((l) => `${PAD}${dim(l)}`).join("\n");

/** Width-aware padding that ignores escape sequences, so a coloured cell lines
 *  up with a plain one. `String.padEnd` counts the escapes and does not. */
export const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
export const fit = (s, w, right = false) => {
  const gap = Math.max(0, w - plain(s).length);
  return right ? " ".repeat(gap) + s : s + " ".repeat(gap);
};

/** A table whose cells may already be coloured. Same contract as core/util's
 *  `table`, minus the assumption that a cell's length is its width. */
export function grid(rows, { header = null, gap = 3 } = {}) {
  const all = header ? [header, ...rows] : rows;
  const w = [];
  for (const r of all) r.forEach((c, i) => (w[i] = Math.max(w[i] || 0, plain(c ?? "").length)));
  const line = (r, paintCell = (x) => x) => r.map((c, i) => fit(paintCell(c ?? ""), w[i])).join(" ".repeat(gap)).trimEnd();
  const body = rows.map((r) => `${PAD}${line(r)}`);
  if (!header) return body.join("\n");
  return [`${PAD}${line(header, (c) => mute(c))}`, ...body].join("\n");
}
