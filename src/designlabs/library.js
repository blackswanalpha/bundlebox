// library.js — the read side of designlabs/: the doctrine cards and the source
// registry that ship with the package. Both are data on disk, parsed here once.
// A card is markdown a human reads and a `- key: value` header a machine reads,
// so there is one file per principle and not two that can disagree.
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "../core/paths.js";
import { readText } from "../core/fs.js";

export const LAB_ROOT = path.join(PKG_ROOT, "designlabs");
export const CARD_DIR = path.join(LAB_ROOT, "principles");
export const SOURCES_FILE = path.join(LAB_ROOT, "sources.json");

const HEADER = /^-\s+([a-z_]+)\s*:\s*(.+)$/;

/** One card: {id, title, field, source, rule, check, severity, body, file}. */
export function parseCard(text, file) {
  const lines = text.split("\n");
  const title = (lines.find((l) => l.startsWith("# ")) || "# ").slice(2).trim();
  const meta = {};
  let i = lines.findIndex((l) => l.startsWith("# ")) + 1;
  for (; i < lines.length; i++) {
    const m = HEADER.exec(lines[i].trim());
    if (m) meta[m[1]] = m[2].trim();
    else if (lines[i].trim()) break;
  }
  return { id: meta.id || path.basename(file, ".md"), title, field: meta.field || "", source: meta.source || "",
    rule: meta.rule || "", check: meta.check || "", severity: meta.severity || "low",
    body: lines.slice(i).join("\n").trim(), file };
}

let _cards = null;
/** Every doctrine card, sorted by severity then id. */
export function cards() {
  if (_cards) return _cards;
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  let names = [];
  try { names = fs.readdirSync(CARD_DIR).filter((n) => n.endsWith(".md") && !n.startsWith("_")); } catch { names = []; }
  _cards = names.map((n) => parseCard(readText(path.join(CARD_DIR, n)), path.join(CARD_DIR, n)))
    .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.id.localeCompare(b.id));
  return _cards;
}
export const card = (id) => cards().find((c) => c.id === id) || null;
/** rule name -> card, for the gate to cite what it is enforcing. */
export const byRule = () => Object.fromEntries(cards().filter((c) => c.rule).map((c) => [c.rule, c]));

let _sources = null;
export function sources() {
  if (_sources) return _sources;
  try { _sources = JSON.parse(readText(SOURCES_FILE, "{}")); } catch { _sources = {}; }
  _sources.providers ||= [];
  _sources.kinds ||= {};
  return _sources;
}
export const provider = (id) => sources().providers.find((p) => p.id === id) || null;
export const providersOf = (kind) => sources().providers.filter((p) => !kind || p.kind === kind);
