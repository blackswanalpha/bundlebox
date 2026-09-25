// scripts/benchmark-page.mjs — docs/benchmark/index.html, built from the runs on disk.
//
// Reads what `bb bench run` and `bb bench swebench run` already wrote and draws
// it. Nothing here measures anything: if a number is not in one of the four
// inputs below it does not appear on the page, and the two numbers the page
// derives rather than reads (dollars, prefill seconds) say so at the mark.
//
//   .bundlebox/bench/swebench/latest.json   SWE-bench Verified, both arms
//   .bundlebox/out/bench/latest.json        this repo's own findings, both arms
//   the `bench` store                       every run ever recorded
//   src/tokens/prices.js                    vendor list prices, with their date
//
// Regenerate:  node scripts/benchmark-page.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prices from "../src/tokens/prices.js";
import * as store from "../src/core/store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch { return d; } };

// A scheduled run rewrites `latest.json` with whatever --n it was installed
// with, so a page built from it silently changes size between builds. Pin the
// run with BB_SWEBENCH_RUN when the page is meant to stand next to a review.
const SWE = read(process.env.BB_SWEBENCH_RUN || ".bundlebox/bench/swebench/latest.json"); // unpinned: the cron-owned run, per the note above
const LOCAL = read(".bundlebox/out/bench/latest.json");
const HISTORY = store.rows("bench", { limit: 1000 });
const BOARD = read("bench/deepswe/leaderboard.json");
if (!SWE || !LOCAL) { console.error("no bench run on disk. `bb bench run` and `bb bench swebench run` first."); process.exit(2); }

// ── numbers ────────────────────────────────────────────────────────────────
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The run's own prose carries backticks; they are markup there, not literals.
const mark = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>");
const tok = (n) => (n >= 1000 ? `${r1(n / 1000)}k` : String(Math.round(n)));
const usd = (n) => (n >= 1 ? `$${r2(n)}` : `${(n * 100) < 1 ? (n * 100).toFixed(2) : (n * 100).toFixed(1)}¢`);
const ms = (n) => (n >= 1000 ? `${r1(n / 1000)}s` : `${Math.round(n)}ms`);

const sOk = SWE.instances.filter((x) => !x.error);
const N = sOk.length;
const st = SWE.totals;
const lt = LOCAL.totals;

// Per task, not per run: a run of 100 and a run of 12 are not comparable totals.
const per = {
  swe: { bare: st.bare / N, bb: st.packed / N },
  local: { bare: lt.bare / lt.measured, bb: lt.packed / lt.measured },
};

// Latency is measured per arm inside `bb bench arm`; older runs have no split,
// and a missing number is left missing rather than back-filled.
const lat = (rows, n) => {
  const b = rows.filter((x) => x.bare_ms != null), p = rows.filter((x) => x.packed_ms != null);
  return b.length && p.length
    ? { bare: b.reduce((s, x) => s + x.bare_ms, 0) / b.length, bb: p.reduce((s, x) => s + x.packed_ms, 0) / p.length, n: Math.min(b.length, p.length) }
    : null;
};
const sweLat = lat(sOk, N);
// Most of the packed wall-clock on SWE-bench is a first visit: every instance is
// a repository bb has never scanned. A workspace pays that once, not per task,
// which is why the warm number beside it is the one to read.
const spaceRows = sOk.filter((x) => x.space?.ms);
const spaceMs = spaceRows.length ? spaceRows.reduce((a, x) => a + x.space.ms, 0) / spaceRows.length : null;
const localLat = lat(LOCAL.tasks.filter((t) => !t.error));

// Dollars are arithmetic over the measured token counts at the vendor's own
// list price. The price table carries its date; a model missing from it is
// reported with tokens and no cost, which is why this list is exactly three.
const MODELS = [
  ["claude-opus-5", "Opus 5"],
  ["claude-sonnet-5", "Sonnet 5"],
  ["claude-haiku-4-5", "Haiku 4.5"],
];
const dollars = MODELS.map(([id, name]) => ({
  id, name,
  bare: prices.cost(id, { inp: per.swe.bare }).total,
  bb: prices.cost(id, { inp: per.swe.bb }).total,
}));

const bareAll = sOk.filter((r) => r.bare_localisation.gold && r.bare_localisation.hit === r.bare_localisation.gold).length;
const bareAny = sOk.filter((r) => r.bare_localisation.hit > 0).length;

const BUDGET = 1e6;
const tasksPerBudget = { bare: Math.floor(BUDGET / per.swe.bare), bb: Math.floor(BUDGET / per.swe.bb) };

const hist = HISTORY.filter((r) => r.saved_pct != null && r.at);
const histDefault = hist.filter((r) => r.suite !== "swebench");
const histSwe = hist.filter((r) => r.suite === "swebench");

// ── svg ────────────────────────────────────────────────────────────────────
const W = 720;
const AX = "var(--rule)", INK = "var(--ink)", MUT = "var(--muted)", FNT = "var(--faint)";

/** Grouped horizontal bars. Two arms per category, a 2px surface gap between
 *  them, the value written at the end of each bar — the relief the palette
 *  check asks for, and the reason no chart here needs its colour read. */
function hbars({ cats, bare, bb, fmt, max = null, labelBare = "bare Claude", labelBB = "bundlebox Claude" }) {
  const BH = 19, GAP = 2, PAD = 30, TOP = 8, LBL = 20;
  const rowH = LBL + BH * 2 + GAP + PAD;
  const H = TOP + cats.length * rowH;
  const plotL = 0, plotW = W - 96;
  const hi = max ?? Math.max(...bare, ...bb) * 1.02;
  const x = (v) => (hi > 0 ? (v / hi) * plotW : 0);
  const out = [];
  cats.forEach((c, i) => {
    const y0 = TOP + i * rowH;
    out.push(`<text x="0" y="${y0 + 11}" class="cat">${esc(c)}</text>`);
    [[bare[i], "bare", labelBare, y0 + LBL], [bb[i], "bb", labelBB, y0 + LBL + BH + GAP]].forEach(([v, k, nm, y]) => {
      const w = Math.max(x(v), 2);
      out.push(`<rect class="bar ${k}" x="${plotL}" y="${y}" width="${w}" height="${BH}" rx="4"`
        + ` data-k="${esc(nm)} · ${esc(c)}" data-v="${esc(fmt(v))}"></rect>`
        + `<text x="${plotL + w + 8}" y="${y + BH / 2 + 4}" class="val">${esc(fmt(v))}</text>`);
    });
  });
  return svg(H, out.join(""));
}

/** One point per instance, sorted by the bare arm. 100 paired measurements as
 *  two totals is a claim; as two curves it is a distribution, and the reader
 *  can see the instances where the gap is small. */
function pairedArea({ rows, fmt }) {
  const H = 230, L = 46, R = 8, T = 10, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const hi = Math.max(...rows.map((r) => r.bare)) * 1.04;
  const x = (i) => L + (rows.length > 1 ? (i / (rows.length - 1)) * pw : pw / 2);
  const y = (v) => T + ph - (v / hi) * ph;
  const line = (key) => rows.map((r, i) => `${i ? "L" : "M"}${r1(x(i))},${r1(y(r[key]))}`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = hi * f;
    return `<line x1="${L}" y1="${r1(y(v))}" x2="${W - R}" y2="${r1(y(v))}" class="grid"/>`
      + `<text x="${L - 8}" y="${r1(y(v)) + 4}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`;
  }).join("");
  const dots = rows.map((r, i) => `<circle class="hit" cx="${r1(x(i))}" cy="${r1(y(r.bare))}" r="9"`
    + ` data-k="${esc(r.label)}" data-v="bare ${esc(fmt(r.bare))} · bundlebox ${esc(fmt(r.bb))}"></circle>`).join("");
  return svg(H, ticks
    + `<path d="${line("bare")}L${r1(x(rows.length - 1))},${T + ph}L${L},${T + ph}Z" class="fill bare"/>`
    + `<path d="${line("bb")}L${r1(x(rows.length - 1))},${T + ph}L${L},${T + ph}Z" class="fill bb"/>`
    + `<path d="${line("bare")}" class="ln bare"/><path d="${line("bb")}" class="ln bb"/>`
    + `<text x="${L}" y="${H - 6}" class="tick">most context</text>`
    + `<text x="${W - R}" y="${H - 6}" class="tick" text-anchor="end">least — ${rows.length} instances</text>`
    + dots);
}

/** Every run the store has kept, one measure per panel.
 *  Faceted rather than overlaid because the two suites are not two arms: green
 *  means the bundlebox arm everywhere else on this page, and a line that meant
 *  "suite" instead would be the same colour saying a different thing. */
function trendPanel({ title, points, t0, t1, mark, fmt, last }) {
  const H = 138, L = 46, R = 12, T = 26, B = 20;
  const pw = W - L - R, ph = H - T - B;
  const x = (t) => L + (t1 > t0 ? ((t - t0) / (t1 - t0)) * pw : pw / 2);
  const y = (v) => T + ph - (v / 100) * ph;
  const day = (t) => new Date(t).toISOString().slice(5, 10);
  const pts = points.slice().sort((a, b) => a.t - b.t);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${r1(x(p.t))},${r1(y(p.v))}`).join("");
  const grid = [0, 50, 100].map((v) => `<line x1="${L}" y1="${r1(y(v))}" x2="${W - R}" y2="${r1(y(v))}" class="grid"/>`
    + `<text x="${L - 8}" y="${r1(y(v)) + 4}" class="tick" text-anchor="end">${v}%</text>`).join("");
  const mk = mark && mark.t > t0 && mark.t < t1
    ? `<line class="mark" x1="${r1(x(mark.t))}" y1="${T - 4}" x2="${r1(x(mark.t))}" y2="${T + ph}"/>`
      + `<text class="mk" x="${r1(x(mark.t)) + 5}" y="${T + ph - 5}">${esc(mark.label)}</text>` : "";
  const dots = pts.map((p) => `<circle class="hit" cx="${r1(x(p.t))}" cy="${r1(y(p.v))}" r="7"`
    + ` data-k="${esc(title)} · ${esc(day(p.t))}" data-v="${esc(fmt(p.v))}"></circle>`).join("");
  const end = pts[pts.length - 1];
  return svg(H, `<text x="0" y="11" class="cat">${esc(title)}</text>`
    + grid + mk + `<path d="${d}" class="ln bb"/>`
    + `<circle cx="${r1(x(end.t))}" cy="${r1(y(end.v))}" r="3.5" fill="var(--s-bb)" stroke="var(--panel)" stroke-width="2"/>`
    + `<text x="${r1(x(end.t)) - 8}" y="${r1(y(end.v)) - 8}" class="val" text-anchor="end">${esc(last(end.v))}</text>`
    + dots
    + `<text x="${L}" y="${H - 5}" class="tick">${esc(day(t0))}</text>`
    + `<text x="${W - R}" y="${H - 5}" class="tick" text-anchor="end">${esc(day(t1))}</text>`);
}

/** A value with its published interval. Somebody else's measurement, drawn with
 *  the uncertainty they reported rather than as a bare number. */
function dotsCI({ rows, max = 100, unit = "%", fmt }) {
  const RH = 21, L = 128, R = 58, T = 8, B = 16;
  const H = T + rows.length * RH + B, pw = W - L - R;
  const x = (v) => L + (v / max) * pw;
  const step = max / 4;
  const grid = [0, 1, 2, 3, 4].map((i) => Math.round(i * step)).map((v) =>
    `<line x1="${r1(x(v))}" y1="${T}" x2="${r1(x(v))}" y2="${T + rows.length * RH}" class="grid"/>`
    + `<text x="${r1(x(v))}" y="${H - 4}" class="tick" text-anchor="middle">${v}${unit}</text>`).join("");
  const body = rows.map((d, i) => {
    const y = T + i * RH + RH / 2;
    const k = d.kind || (d.hi ? "bare" : "neu");
    return `<text x="0" y="${y + 4}" class="rowlab${d.hi ? " hi" : ""}${d.kind === "bb" ? " bbrow" : ""}">${esc(d.label)}</text>`
      + (d.ci ? `<line x1="${r1(x(Math.max(0, d.v - d.ci)))}" y1="${y}" x2="${r1(x(Math.min(max, d.v + d.ci)))}" y2="${y}" class="whisk ${k}"/>` : "")
      + `<circle cx="${r1(x(d.v))}" cy="${y}" r="4.5" class="dot ${k}${d.open ? " open" : ""}"`
      + ` data-k="${esc(d.label)}" data-v="${esc(fmt(d))}"></circle>`
      + `<text x="${W - R + 8}" y="${y + 4}" class="val">${d.prefix || ""}${d.v}${unit}`
      + (d.ci ? `<tspan class="pm"> ±${d.ci}</tspan>` : "") + `</text>`;
  }).join("");
  return svg(H, grid + body);
}

/** The smallest true difference a run of N paired tasks could separate from
 *  noise. Arithmetic over the board's own baseline, not a result. */
function powerCurve({ series, at }) {
  const H = 232, L = 52, R = 96, T = 12, B = 34;
  const pw = W - L - R, ph = H - T - B, hiY = 50;
  const ns = series[0].points.map((p) => p.n);
  const lo = Math.min(...ns), hi = Math.max(...ns);
  const lx = (n) => L + ((Math.log10(n) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * pw;
  const y = (v) => T + ph - (Math.min(v, hiY) / hiY) * ph;
  const grid = [0, 10, 20, 30, 40, 50].map((v) =>
    `<line x1="${L}" y1="${r1(y(v))}" x2="${W - R}" y2="${r1(y(v))}" class="grid"/>`
    + `<text x="${L - 8}" y="${r1(y(v)) + 4}" class="tick" text-anchor="end">${v}</text>`).join("");
  const marker = at ? `<line x1="${r1(lx(at))}" y1="${T}" x2="${r1(lx(at))}" y2="${T + ph}" class="mark"/>`
    + `<text class="mk" x="${r1(lx(at)) + 5}" y="${T + 10}">${at} tasks — the whole corpus</text>` : "";
  // The three curves converge at the right, so their end labels collide. Push
  // them apart from the bottom up and keep each one's colour.
  const ends = series.map((s2) => ({ s2, y: y(s2.points[s2.points.length - 1].d) }))
    .sort((a, b) => b.y - a.y);
  ends.forEach((e, i) => { if (i && ends[i - 1].y - e.y < 13) e.y = ends[i - 1].y - 13; });
  const endY = new Map(ends.map((e) => [e.s2.step, e.y]));
  const body = series.map((s2) => {
    const d = s2.points.map((p, i) => `${i ? "L" : "M"}${r1(lx(p.n))},${r1(y(p.d))}`).join("");
    const end = s2.points[s2.points.length - 1];
    const dots = s2.points.map((p) => `<circle class="hit" cx="${r1(lx(p.n))}" cy="${r1(y(p.d))}" r="7"`
      + ` data-k="${p.n} tasks · ${Math.round(s2.pd * 100)}% discordance"`
      + ` data-v="resolves ${r1(p.d)} pts"></circle>`).join("");
    return `<path d="${d}" class="ln ramp${s2.step}"/>`
      + `<text x="${W - R + 8}" y="${r1(endY.get(s2.step)) + 4}" class="val ramp${s2.step}">${Math.round(s2.pd * 100)}%</text>` + dots;
  }).join("");
  const ticks = series[0].points.filter((p) => [10, 113, 500].includes(p.n))
    .map((p) => `<text x="${r1(lx(p.n))}" y="${H - 14}" class="tick" text-anchor="middle">${p.n}</text>`).join("");
  return svg(H, grid + marker + body + ticks
    + `<text x="${L}" y="${H - 1}" class="tick">tasks per arm (log)</text>`
    + `<text x="${W - R + 8}" y="${T + 8}" class="tick">arms</text>`
    + `<text x="${W - R + 8}" y="${T + 20}" class="tick">disagree</text>`
    + `<text x="${L - 46}" y="${T - 1}" class="tick">pts</text>`);
}

const svg = (h, body) => `<svg class="chart" viewBox="0 0 ${W} ${h}" role="img" preserveAspectRatio="xMinYMin meet">${body}</svg>`;

const legend = (a = "bare Claude", b = "bundlebox Claude") =>
  `<div class="legend"><span><i class="sw bare"></i>${esc(a)}</span><span><i class="sw bb"></i>${esc(b)}</span></div>`;

const table = (head, rows) => `<details class="tv"><summary>Table view</summary><table><thead><tr>`
  + head.map((h) => `<th>${esc(h)}</th>`).join("") + `</tr></thead><tbody>`
  + rows.map((r) => `<tr>` + r.map((c, i) => `<td${i ? ` class="n"` : ""}>${esc(c)}</td>`).join("") + `</tr>`).join("")
  + `</tbody></table></details>`;

const fig = ({ id, kicker, title, lead, chart, legend: lg = true, note, extra, tbl }) => `
<figure class="fig" id="${id}">
  <p class="kicker">${esc(kicker)}</p>
  <h3>${esc(title)}</h3>
  ${lead ? `<p class="lead">${lead}</p>` : ""}
  ${lg ? legend() : ""}
  <div class="plot">${chart}</div>
  ${note ? `<p class="note">${note}</p>` : ""}
  ${extra || ""}
  ${tbl || ""}
</figure>`;

// ── the figures ────────────────────────────────────────────────────────────
const figs = [];

figs.push(fig({
  id: "context", kicker: `SWE-bench Verified · ${N} instances`,
  title: "Context put in the window, per task",
  lead: `Same issue text, same checkout, same estimator. <b>Bare</b> greps the tree, reads what came back, then opens an ${LOCAL.bare_range}-line range in each of the top ${SWE.bare_read_cap} files; <b>bundlebox</b> answers with one <code>bb pinpoint</code> brief. Averaged over ${N} instances and over this repository's own ${lt.measured} open findings.`,
  chart: hbars({
    cats: [`SWE-bench Verified (${N} instances)`, `bundlebox's own findings (${lt.measured} tasks)`],
    bare: [per.swe.bare, per.local.bare], bb: [per.swe.bb, per.local.bb], fmt: (v) => `${tok(v)} tok`,
  }),
  note: `<b>${st.saved_pct}% less</b> on SWE-bench (${st.ratio}×) and <b>${lt.saved_pct}% less</b> here (${lt.ratio}×). Both arms are token counts over text on disk. Neither called a model.`,
  tbl: table(["suite", "bare / task", "bundlebox / task", "saved", "ratio"], [
    [`SWE-bench Verified`, `${tok(per.swe.bare)}`, `${tok(per.swe.bb)}`, `${st.saved_pct}%`, `${st.ratio}×`],
    [`bundlebox findings`, `${tok(per.local.bare)}`, `${tok(per.local.bb)}`, `${lt.saved_pct}%`, `${lt.ratio}×`],
  ]),
}));

figs.push(fig({
  id: "cost", kicker: `derived · list prices as of ${prices.AS_OF}`,
  title: "What one task costs to read, in dollars",
  lead: `The measured token counts above, multiplied by each model's published input price. <b>Derived, not measured</b>: no request was sent. One task, read once, no cache.`,
  chart: hbars({
    cats: dollars.map((d) => d.name), bare: dollars.map((d) => d.bare), bb: dollars.map((d) => d.bb),
    fmt: (v) => usd(v),
  }),
  note: `Per 1,000 tasks that is ${usd(dollars[0].bare * 1000)} against ${usd(dollars[0].bb * 1000)} on ${dollars[0].name} — <b>${usd((dollars[0].bare - dollars[0].bb) * 1000)} saved</b>. Prices: ${esc(prices.SOURCE)}.`,
  tbl: table(["model", "bare / task", "bundlebox / task", "bare / 1k tasks", "bundlebox / 1k tasks"],
    dollars.map((d) => [d.name, usd(d.bare), usd(d.bb), usd(d.bare * 1000), usd(d.bb * 1000)])),
}));

figs.push(fig({
  id: "recall", kicker: `SWE-bench Verified · ${st.gold} gold files`,
  title: "Did the files the maintainer changed make the window?",
  lead: `Scored against <code>patch</code>, the fix that ships with the dataset. <b>In scope</b> means the brief budgets the file to be read; <b>named</b> means it is also pointed at as a ranked candidate. This is a localisation score, <b>not a resolve rate</b>.`,
  chart: hbars({
    cats: ["Gold files recalled", "Instances with every gold file", "Instances with at least one"],
    bare: [st.bare_recall, (bareAll / N) * 100, (bareAny / N) * 100],
    bb: [st.recall, (st.all / N) * 100, (st.any / N) * 100],
    fmt: (v) => `${r1(v)}%`, max: 100,
  }),
  legend: true,
  note: `<b>${st.recall}%</b> of gold files are inside the packed scope against <b>${st.bare_recall}%</b> for the bare arm, and <b>${st.named_recall}%</b> are at least named. Whole instances: bundlebox has every gold file in scope on <b>${st.all}</b> of ${N} against <b>${bareAll}</b> bare — and the bare arm read ${SWE.bare_read_cap} whole files to get there.`,
  tbl: table(["measure", "bare Claude", "bundlebox Claude"], [
    ["gold files recalled", `${st.bare_recall}% (${st.bare_hit}/${st.gold})`, `${st.recall}% (${st.hit}/${st.gold})`],
    ["gold files named", "—", `${st.named_recall}% (${st.named_hit}/${st.gold})`],
    ["instances with every gold file", `${bareAll}/${N}`, `${st.all}/${N}`],
    ["instances with at least one", `${bareAny}/${N}`, `${st.any}/${N}`],
    ["files put in front of the model", `${SWE.bare_read_cap} read whole`, `${r1(sOk.reduce((a, x) => a + x.localisation.found, 0) / N)} in scope (avg)`],
  ]),
}));

if (sweLat) figs.push(fig({
  id: "latency", kicker: "measured wall-clock · per arm",
  title: "Time to a window, and the time the model then spends reading it",
  lead: `The one chart that does not favour bundlebox. Building a brief is real local work: <b>${ms(sweLat.bb)}</b> against <b>${ms(sweLat.bare)}</b> to grep and read. That is the trade — seconds of your CPU for tokens of the model's window.`,
  chart: hbars({
    cats: [`Assembling the window — SWE-bench, a repo bb has never seen (${sweLat.n} instances)`, ...(localLat ? [`Assembling the window — a workspace already scanned (${localLat.n} tasks)`] : [])],
    bare: [sweLat.bare, ...(localLat ? [localLat.bare] : [])],
    bb: [sweLat.bb, ...(localLat ? [localLat.bb] : [])],
    fmt: (v) => ms(v),
  }),
  note: `${spaceMs ? `Most of that is a first visit: <b>${ms(spaceMs)}</b> of the ${ms(sweLat.bb)} is building the symbol space for a repository bb has never scanned, which a workspace pays once rather than per task. ` : ""}Against it, the window the model then has to read: <b>${tok(per.swe.bare)}</b> tokens bare, <b>${tok(per.swe.bb)}</b> packed. Prefill is the model's time rather than yours and scales with the count — set a rate and the arithmetic follows.`,  extra: `<div class="ctl"><label for="tps">Model reads input at</label><select id="tps" data-bare="${Math.round(per.swe.bare)}" data-bb="${Math.round(per.swe.bb)}" data-lbare="${Math.round(sweLat.bare)}" data-lbb="${Math.round(sweLat.bb)}"${localLat ? ` data-wbare="${Math.round(localLat.bare)}" data-wbb="${Math.round(localLat.bb)}" data-wtbare="${Math.round(per.local.bare)}" data-wtbb="${Math.round(per.local.bb)}"` : ""}><option value="500">500 tok/s</option><option value="1000" selected>1,000 tok/s</option><option value="2000">2,000 tok/s</option><option value="4000">4,000 tok/s</option></select></div><p class="note" id="pf-note"></p>`,
  tbl: table(["stage", "bare Claude", "bundlebox Claude"], [
    ["assemble the window — repo never scanned", ms(sweLat.bare), ms(sweLat.bb)],
    ...(spaceMs ? [["— of which: the first-visit symbol space", "—", ms(spaceMs)]] : []),
    ...(localLat ? [["assemble the window — workspace already scanned", ms(localLat.bare), ms(localLat.bb)]] : []),
    ["tokens the model must then read", tok(per.swe.bare), tok(per.swe.bb)],
  ]),
}));

const sorted = sOk.slice().sort((a, b) => b.bare - a.bare)
  .map((x) => ({ label: x.id, bare: x.bare, bb: x.packed }));
figs.push(fig({
  id: "spread", kicker: `SWE-bench Verified · every instance`,
  title: "The gap, instance by instance",
  lead: `Not an average. Each x is one of the ${N} instances, sorted by what the bare arm cost. The bundlebox curve stays flat because a brief is budgeted; the bare curve is whatever the tree happened to contain.`,
  chart: pairedArea({ rows: sorted, fmt: (v) => `${tok(v)}` }),
  note: `Widest gap: <b>${esc(sorted[0].label)}</b> at ${tok(sorted[0].bare)} against ${tok(sorted[0].bb)}. ${sOk.filter((x) => x.saved <= 0).length} instance(s) cost more packed than bare; they are counted in every total on this page.`,
}));

figs.push(fig({
  id: "throughput", kicker: "derived from the measured averages",
  title: "Tasks you get from a million input tokens",
  lead: `The same budget, divided by what one task costs to read.`,
  chart: hbars({
    cats: ["Tasks per 1M input tokens"],
    bare: [tasksPerBudget.bare], bb: [tasksPerBudget.bb], fmt: (v) => `${Math.round(v)} tasks`,
  }),
  note: `<b>${tasksPerBudget.bb}</b> against <b>${tasksPerBudget.bare}</b> — ${r1(tasksPerBudget.bb / tasksPerBudget.bare)}× the work from the same budget.`,
  tbl: table(["budget", "bare Claude", "bundlebox Claude"], [
    ["1M input tokens", `${tasksPerBudget.bare} tasks`, `${tasksPerBudget.bb} tasks`],
  ]),
}));

// The bare arm was re-modelled on 2026-09-19 (1cdb60a): it stopped reading
// matched files whole and started opening one 80-line range per hit. Every
// saving reported before that mark is against a more wasteful baseline, so the
// step down is the benchmark getting stricter, not bundlebox getting worse.
const MARK = { t: Date.parse("2026-09-19T00:10:58+03:00"), label: "bare arm re-modelled — 1cdb60a" };
const tAll = hist.map((r) => Date.parse(r.at));
const tLo = Math.min(...tAll), tHi = Math.max(...tAll);
const sweRecall = histSwe.filter((r) => r.recall != null);

if (histDefault.length > 2) figs.push(fig({
  id: "trend", kicker: `${hist.length} recorded runs`,
  title: "Every run the store has kept",
  lead: `One measure per panel, because a single flattering run is not evidence and two suites are not two arms. The step on ${esc(MARK.label.split(" — ")[1])} is the <b>baseline</b> changing: the bare arm stopped reading matched files whole and started opening one ${LOCAL.bare_range}-line range per hit. Everything left of it is measured against a more wasteful bare arm.`,
  legend: false,
  chart: [
    trendPanel({ title: "Context saved — bundlebox's own findings", t0: tLo, t1: tHi, mark: MARK,
      points: histDefault.map((r) => ({ t: Date.parse(r.at), v: r.saved_pct })),
      fmt: (v) => `${r1(v)}% saved`, last: (v) => `${r1(v)}%` }),
    trendPanel({ title: "Context saved — SWE-bench Verified", t0: tLo, t1: tHi, mark: MARK,
      points: histSwe.map((r) => ({ t: Date.parse(r.at), v: r.saved_pct })),
      fmt: (v) => `${r1(v)}% saved`, last: (v) => `${r1(v)}%` }),
    ...(sweRecall.length > 2 ? [trendPanel({ title: "Gold files located — SWE-bench Verified", t0: tLo, t1: tHi, mark: null,
      points: sweRecall.map((r) => ({ t: Date.parse(r.at), v: r.recall })),
      fmt: (v) => `${r1(v)}% recall`, last: (v) => `${r1(v)}%` })] : []),
  ].join(""),
  note: `${histDefault.length} runs on this repository's findings, ${histSwe.length} on SWE-bench. Localisation is the line that moved on its own merits: ${r1(sweRecall[0].recall)}% of gold files on the first recorded run, ${r1(sweRecall[sweRecall.length - 1].recall)}% on the last. The baseline change did not touch it.`,
}));

// ── DeepSWE: someone else's board, and what it would take to join it ──────
//
// No bundlebox row appears here and that is deliberate. Every number in this
// section is either read off the public board or is arithmetic over it; a
// resolve rate this tree has not measured does not get drawn beside ones that
// were, whatever it would look like.
const deepswe = [];
if (BOARD) {
  const R = BOARD.rows.map(([model, effort, score, ci, usd, toks, steps]) =>
    ({ model, effort, score, ci, usd, toks, steps, claude: /^claude-/.test(model) }));
  const byScore = R.slice().sort((a, b) => b.score - a.score);
  const son = R.find((r) => r.model === "claude-sonnet-5");
  const medTok = [...R].sort((a, b) => a.toks - b.toks)[Math.floor(R.length / 2)].toks;

  // What a run could separate from noise. BOTH ARMS RUN THE SAME TASKS, so the
  // test is McNemar's on the pairs that disagree, not two independent
  // proportions. The unpaired form this file used first needed 376 tasks for
  // ten points where the paired form needs 116; it was answering a question
  // nobody was asking. The paired answer depends on the discordance rate, which
  // nothing here has measured, so it is carried as a band rather than a number.
  const za2 = 1.959964, zb = 0.8416212;
  const nPaired = (d, pd) => Math.pow(za2 * Math.sqrt(pd) + zb * Math.sqrt(Math.max(pd - d * d, 1e-9)), 2) / (d * d);
  const DISC = [0.15, 0.25, 0.35];
  const solveP = (N, pd) => { let lo = 1e-4, hi = Math.min(0.95 * pd, 0.45);
    for (let i = 0; i < 300; i++) { const m = (lo + hi) / 2; if (nPaired(m, pd) > N) lo = m; else hi = m; } return hi * 100; };
  // the bar on the full corpus, at the middle discordance assumption
  const BAR = solveP(BOARD.tasks, 0.25);
  const BAR_LO = solveP(BOARD.tasks, DISC[0]), BAR_HI = solveP(BOARD.tasks, DISC[2]);
  const nNI = (m, pd) => Math.ceil(Math.pow(za2 + zb, 2) * pd / (m * m));
  const NS = [10, 25, 50, 113, 250, 500, 1000];

  deepswe.push(fig({
    id: "board", kicker: `published · ${BOARD.tasks} tasks · ${BOARD.as_of}`,
    title: "DeepSWE, as the board reports it",
    lead: `A real resolve rate on ${BOARD.tasks} long-horizon tasks, ${esc(BOARD.scoring)}, all on ${esc(BOARD.scaffold)}. <b>These are Datacurve's measurements, not ours</b> — read off <a href="${esc(BOARD.source)}">the public board</a> and reproduced nowhere in this repository. Anthropic models are marked.`,
    legend: false,
    chart: dotsCI({ rows: [...byScore.map((r) => ({ label: r.model, v: r.score, ci: r.ci, hi: r.claude })),
        { label: "claude-sonnet-5 (bundlebox)", v: Math.round(son.score + BAR), ci: Math.round((BAR_HI - BAR_LO) / 2),
          kind: "bb", open: true, prefix: "\u2265", note: "threshold, not a score" }]
        .sort((a, b) => b.v - a.v),
      fmt: (d) => (d.kind === "bb" ? `${d.v}% — the least this corpus could tell apart from ${son.score}%` : `${d.v}% ±${d.ci}`) }),
    note: `The board's own reading is that leading coding benchmarks are saturating at the frontier: the top nine sit inside eight points of each other with intervals of ±1 to ±6, so most of that ordering is not separable. <b>${son.model}</b> scores <b>${son.score}% ±${son.ci}</b>.<br><br>The hollow green row is <b>not a result and not a prediction</b>. bundlebox has never been run on this benchmark. It marks the <b>bar</b>: on all ${BOARD.tasks} tasks the smallest gain separable from ${son.score}% is ${r1(BAR_LO)}-${r1(BAR_HI)} points depending on how often the two arms disagree, so anything below about <b>${Math.round(son.score + BAR)}%</b> would be indistinguishable from changing nothing. It is drawn so the empty space is visible rather than implied.`,
    tbl: table(["model", "score", "$/task", "tokens/task", "steps"],
      [...byScore.map((r) => [r.model, `${r.score}% ±${r.ci}`, `$${r.usd.toFixed(2)}`, tok(r.toks), String(r.steps)]),
       ["claude-sonnet-5 (bundlebox)", `\u2265${Math.round(son.score + BAR)}% to be detectable — never run`, "—", "—", "—"]]),
  }));

  deepswe.push(fig({
    id: "board-context", kicker: "published · the axis bundlebox acts on",
    title: "Context per task, on the same board",
    lead: `bundlebox changes neither the model, the scaffold nor the task. It changes what goes in the window. So this is the column where it could act at all — and it is the column <b>${son.model}</b> is worst on.`,
    legend: false,
    chart: dotsCI({ rows: byScore.map((r) => ({ label: r.model, v: Math.round(r.toks / 1000), hi: r.claude })),
      max: 220, unit: "k", fmt: (d) => `${d.v}k tokens per task` }),
    note: `<b>${son.model}</b> spends <b>${tok(son.toks)}</b> tokens and <b>$${son.usd.toFixed(2)}</b> across <b>${son.steps}</b> steps per task — ${r1(son.toks / medTok)}× the median of ${tok(medTok)}, and the dearest row on the board — to land ${son.score}%. Nothing here says bundlebox would move that. It says this is where a change would have to show up.`,
  }));

  // (the power maths is hoisted above the first figure; see Z/p0/BAR)

  deepswe.push(fig({
    id: "power", kicker: "derived · arithmetic over the board",
    title: "What a run here could actually tell you",
    lead: `Both arms run the same tasks, so the test is McNemar's on the tasks where they disagree. How many that is — the <b>discordance rate</b> — is not known until a run happens, so this is drawn as a band across three assumptions rather than one line. <b>Derived, not measured.</b>`,
    legend: false,
    chart: powerCurve({
      series: DISC.map((pd, i) => ({
        pd, step: i,
        points: NS.map((n) => ({ n, d: solveP(n, pd) })),
      })),
      at: BOARD.tasks,
    }),
    note: `On all ${BOARD.tasks} tasks the smallest gain separable from ${son.score}% is <b>${r1(BAR_LO)} to ${r1(BAR_HI)} points</b> depending on how often the arms disagree — about <b>${r1(BAR)}</b> at the middle assumption. A <b>10-point</b> gain needs ${nNI(0.10, DISC[0])} to ${nNI(0.10, DISC[2])} tasks, so this corpus is borderline for ten points and adequate for fifteen. Treating the two arms as independent samples instead of pairs would put that figure near 376 and understate the benchmark badly.`,
    tbl: table(["tasks per arm", "15% discordance", "25%", "35%"],
      NS.map((n) => [String(n), `${r1(solveP(n, 0.15))} pts`, `${r1(solveP(n, 0.25))} pts`, `${r1(solveP(n, 0.35))} pts`])),
  }));
}

// ── page ───────────────────────────────────────────────────────────────────
const tiles = [
  ["context per task", `${st.saved_pct}%`, `less than bare — ${tok(per.swe.bare)} → ${tok(per.swe.bb)} tokens`],
  ["gold files located", `${st.recall}%`, `in the packed scope, against ${st.bare_recall}% bare`],
  ["cost per 1k tasks", usd((dollars[0].bare - dollars[0].bb) * 1000), `saved on ${dollars[0].name} at list price`],
  ["tasks per 1M tokens", `${tasksPerBudget.bb}`, `against ${tasksPerBudget.bare} bare — ${r1(tasksPerBudget.bb / tasksPerBudget.bare)}×`],
];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bundlebox — benchmarks</title>
<meta name="description" content="What a coding task costs with bundlebox and without it, measured on SWE-bench Verified and on bundlebox's own open findings: context, dollars, localisation, latency.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2048%2048%22%3E%3Crect%20width%3D%2248%22%20height%3D%2248%22%20rx%3D%2211%22%20fill%3D%22%2307271D%22%2F%3E%3Cpath%20d%3D%22M24%207%20L40%2016.2%20L40%2032.8%20L24%2042%20L8%2032.8%20L8%2016.2%20Z%22%20fill%3D%22none%22%20stroke%3D%22%236FEFC0%22%20stroke-width%3D%223%22%20stroke-linejoin%3D%22round%22%2F%3E%3Ccircle%20cx%3D%2224%22%20cy%3D%2223.4%22%20r%3D%226%22%20fill%3D%22%2307271D%22%2F%3E%3Ccircle%20cx%3D%2224%22%20cy%3D%2223.4%22%20r%3D%226%22%20fill%3D%22none%22%20stroke%3D%22%23CFFFEC%22%20stroke-width%3D%223.4%22%2F%3E%3C%2Fsvg%3E">
<style>
:root{
  --ink:#141414; --muted:#63615b; --faint:#908d86; --rule:#e4e1da; --bg:#faf9f6; --panel:#fff;
  --accent:#1f7a5c; --accent-soft:#e9f2ee; --code-bg:#f4f2ec;
  --s-bare:#B04A28; --s-bb:#1baf7a;
  --ramp-1:#8fd9bd; --ramp-2:#34a780; --ramp-3:#0d5c43;
  --sans:"Helvetica Neue",Helvetica,Arial,"Liberation Sans",sans-serif;
  --mono:"SF Mono","JetBrains Mono",ui-monospace,"Liberation Mono",Menlo,monospace;
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ink:#e9e6df; --muted:#9c988f; --faint:#6d6961; --rule:#292b28; --bg:#101110; --panel:#171816;
  --accent:#55b892; --accent-soft:#15271e; --code-bg:#181a17;
  --s-bare:#C05428; --s-bb:#199e70;
  --ramp-1:#0f6b4e; --ramp-2:#2f9d76; --ramp-3:#7fd4b4;
}}
:root[data-theme="dark"]{
  --ink:#e9e6df; --muted:#9c988f; --faint:#6d6961; --rule:#292b28; --bg:#101110; --panel:#171816;
  --accent:#55b892; --accent-soft:#15271e; --code-bg:#181a17;
  --s-bare:#C05428; --s-bb:#199e70;
  --ramp-1:#0f6b4e; --ramp-2:#2f9d76; --ramp-3:#7fd4b4;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.62 var(--sans);letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:0 16px}
@media(min-width:640px){.wrap{padding:0 28px}}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 30%,transparent)}
a:hover{border-bottom-color:var(--accent)}
b{font-weight:600}
code{font-family:var(--mono);font-size:.875em;background:var(--code-bg);padding:2px 5px;border-radius:4px}
header.hero{padding:64px 0 34px}
h1{font-size:clamp(30px,5.4vw,46px);line-height:1.05;letter-spacing:-.035em;margin:0 0 18px;font-weight:700}
.tagline{font-size:18px;line-height:1.5;color:var(--muted);margin:0 0 22px;max-width:34em;letter-spacing:-.012em}
.kicker{color:var(--faint);font:11px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;margin:0 0 8px}
.stamp{font:11.5px/1.5 var(--mono);color:var(--faint);letter-spacing:.02em;margin:0}
h2{font-size:24px;letter-spacing:-.025em;margin:0 0 6px;font-weight:700;line-height:1.2}
h3{font-size:19px;letter-spacing:-.02em;margin:0 0 8px;font-weight:700;line-height:1.25}
p{margin:0 0 16px}
p.lead{color:var(--muted);font-size:15.5px;letter-spacing:-.008em;margin:0 0 18px}
.tiles{display:grid;grid-template-columns:1fr;gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:12px;overflow:hidden;margin:0 0 8px}
@media(min-width:560px){.tiles{grid-template-columns:1fr 1fr}}
@media(min-width:900px){.tiles{grid-template-columns:repeat(4,1fr)}}
.tile{background:var(--panel);padding:18px 16px}
.tile .k{font:10.5px/1 var(--mono);letter-spacing:.09em;text-transform:uppercase;color:var(--faint);margin:0 0 9px}
.tile .v{font-size:30px;line-height:1;letter-spacing:-.03em;font-weight:700;color:var(--accent);margin:0 0 7px}
.tile .s{font-size:12.5px;line-height:1.4;color:var(--muted);margin:0}
section{padding:40px 0;border-top:1px solid var(--rule)}
.fig{margin:0 0 44px;padding:0}
.fig:last-child{margin-bottom:0}
.plot{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:16px 14px;overflow-x:auto;overflow-y:hidden}
@media(max-width:620px){svg.chart{min-width:540px}}
svg.chart{display:block;width:100%;height:auto;overflow:visible}
svg.chart + svg.chart{margin-top:22px}
.chart .bar.bare{fill:var(--s-bare)}
.chart .bar.bb{fill:var(--s-bb)}
.chart .bar{transition:opacity .12s}
.plot:hover .bar{opacity:.45}
.plot .bar:hover{opacity:1}
.chart .ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart .ln.bare{stroke:var(--s-bare)}
.chart .ln.bb{stroke:var(--s-bb)}
.chart .fill.bare{fill:var(--s-bare);opacity:.1;stroke:none}
.chart .fill.bb{fill:var(--s-bb);opacity:.14;stroke:none}
.chart .grid{stroke:var(--rule);stroke-width:1}
.chart .tick{font:10.5px var(--mono);fill:var(--faint)}
.chart .cat{font:11px var(--mono);letter-spacing:.06em;text-transform:uppercase;fill:var(--faint)}
.chart .val{font:12px var(--mono);fill:var(--ink);font-weight:500}
.chart .hit{fill:transparent;stroke:none}
.chart .dot{stroke:var(--panel);stroke-width:1.5}
.chart .dot.neu{fill:var(--faint)}
.chart .dot.bare{fill:var(--s-bare)}
.chart .dot.bb{fill:var(--s-bb)}
.chart .dot.bb.open{fill:var(--panel);stroke:var(--s-bb);stroke-width:2.5;stroke-dasharray:2.4 2}
.chart .rowlab.bbrow{fill:var(--s-bb);font-weight:600}
.chart .ln.ramp0{stroke:var(--ramp-1)}
.chart .ln.ramp1{stroke:var(--ramp-2)}
.chart .ln.ramp2{stroke:var(--ramp-3)}
.chart .val.ramp0{fill:var(--ramp-1)}
.chart .val.ramp1{fill:var(--ramp-2)}
.chart .val.ramp2{fill:var(--ramp-3)}
.chart .whisk{stroke-width:2;stroke-linecap:round;opacity:.42}
.chart .whisk.neu{stroke:var(--faint)}
.chart .whisk.bare{stroke:var(--s-bare)}
.chart .rowlab{font:12px var(--mono);fill:var(--muted)}
.chart .rowlab.hi{fill:var(--s-bare);font-weight:600}
.chart .pm{fill:var(--faint);font-size:10.5px}\n.chart .mark{stroke:var(--faint);stroke-width:1;stroke-dasharray:3 3}\n.chart .mk{font:10px var(--mono);fill:var(--faint)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:var(--muted);margin:0 0 12px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block;flex:0 0 11px}
.sw.bare{background:var(--s-bare)}
.sw.bb{background:var(--s-bb)}
.note{font-size:13.5px;line-height:1.55;color:var(--muted);margin:12px 0 0}
.tv{margin:10px 0 0;font-size:13.5px}
.tv summary{cursor:pointer;color:var(--faint);font:11px var(--mono);letter-spacing:.08em;text-transform:uppercase;list-style:none}
.tv summary::-webkit-details-marker{display:none}
.tv summary::before{content:"▸ ";font-size:10px}
.tv[open] summary::before{content:"▾ "}
.tv table{width:100%;border-collapse:collapse;font-size:13.5px;margin:12px 0 0}
.tv th{text-align:left;font:10.5px var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--faint);font-weight:400;padding:0 12px 8px 0;border-bottom:1px solid var(--rule)}
.tv td{padding:8px 12px 8px 0;border-bottom:1px solid var(--rule);color:var(--muted)}
.tv td.n{font-family:var(--mono);font-size:12.5px;color:var(--ink);white-space:nowrap}
.tv tr:last-child td{border-bottom:0}
.ctl{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin:0 0 14px}
.ctl select{font:13px var(--sans);color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:7px;padding:5px 8px}
#tip{position:fixed;z-index:50;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--panel);border:1px solid var(--rule);
  border-radius:8px;padding:7px 10px;font:12px/1.45 var(--sans);color:var(--ink);box-shadow:0 6px 20px rgba(0,0,0,.14);max-width:260px}
#tip b{display:block;font:10.5px var(--mono);letter-spacing:.05em;color:var(--faint);text-transform:uppercase;margin-bottom:3px;font-weight:400}
.method{font-size:14.5px;color:var(--muted)}
.method h3{color:var(--ink);margin-top:26px}
.method ul{margin:0 0 16px;padding-left:20px}
.method li{margin-bottom:7px}
pre{background:var(--code-bg);border:1px solid var(--rule);border-radius:9px;padding:14px 16px;overflow-x:auto;font:13px/1.6 var(--mono);margin:0 0 18px}
pre code{background:0;padding:0}
footer{padding:36px 0 60px;border-top:1px solid var(--rule);font-size:13px;color:var(--faint)}
.tgl{position:fixed;top:14px;right:14px;z-index:20;background:var(--panel);border:1px solid var(--rule);border-radius:8px;color:var(--muted);
  width:34px;height:31px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto}}
</style>
</head>
<body>
<button class="tgl" id="tgl" aria-label="Toggle colour theme">◐</button>
<div id="tip" role="status" aria-live="polite"></div>

<div class="wrap">
<header class="hero">
  <p class="kicker">bundlebox · benchmarks</p>
  <h1>What the same task costs, with the factory and without it.</h1>
  <p class="tagline">Two arms on the same checkout, the same issue text and the same estimator. <b>Bare</b> is what an agent does with a shell: grep the tree, read what came back, open the top files. <b>bundlebox</b> is one <code>bb pinpoint</code> brief. Neither arm called a model, so none of these numbers is a guess about one.</p>
  <p class="stamp">SWE-bench Verified · ${N} instances · ${esc(String(SWE.at).slice(0, 10))} · ${SWE.seconds}s<br>bundlebox's own findings · ${lt.measured} tasks · ${esc(String(LOCAL.at).slice(0, 10))} · ${LOCAL.seconds}s</p>
</header>

<div class="tiles">
${tiles.map(([k, v, s]) => `  <div class="tile"><p class="k">${esc(k)}</p><p class="v">${esc(v)}</p><p class="s">${s}</p></div>`).join("\n")}
</div>
<p class="note" style="margin-bottom:0">Localisation is a file-level score against the maintainer's own patch. It is <b>not</b> a resolve rate: no model was called and no test was run.</p>

<section>
${figs.join("\n")}
</section>

${deepswe.length ? `<section>
  <p class="kicker">DeepSWE</p>
  <h2>A benchmark this page has no number on</h2>
  <p class="lead">Everything above is a context measurement: what goes in the window, and whether the right files are in it. It is deliberately <b>not</b> a resolve rate. <a href="${esc(BOARD.source)}">DeepSWE</a> is a resolve rate, on ${BOARD.tasks} long-horizon tasks with program-based verifiers — the measurement this repository keeps saying it does not make.</p>
  <p class="lead">So the board is here as published, the column bundlebox would act on is marked, and the size of run it would take to say anything is worked out. <b>No bundlebox row is drawn</b>, because none has been measured. The arm is written and the harness is validated; what is missing is the trials.</p>
${deepswe.join("\n")}
</section>` : ""}

<section class="method">
  <p class="kicker">Method</p>
  <h2>How the two arms are run</h2>
  <p>${mark(SWE.method)}</p>

  <h3>The bare arm</h3>
  <p>Grep the checkout for the task's terms, read the search output, then open a ${LOCAL.bare_range}-line range around the first hit in each of the top ${SWE.bare_read_cap} files. This is the cheapest honest baseline: it is what a shell gives an agent that has no index.</p>

  <h3>The bundlebox arm</h3>
  <p>One <code>bb pinpoint</code> prompt for the same task — the located regions, the scope it may edit, the evidence already on file, and a budget. At most ${SWE.max_files} files enter scope.</p>

  <h3>What is measured and what is not</h3>
  <ul>
    <li><b>Measured:</b> tokens, by bundlebox's own estimator over text on disk, both arms counted the same way. File-level localisation against the dataset's own <code>patch</code>. Wall-clock per arm.</li>
    <li><b>Derived:</b> dollars (measured tokens × ${esc(prices.SOURCE)}, as of ${prices.AS_OF}) and model prefill time (measured tokens ÷ a rate you set). Both are marked where they appear.</li>
    <li><b>Not measured:</b> ${mark(SWE.not_measured)}</li>
  </ul>

  <h3>Reproduce</h3>
  <pre><code>npm i -g bundlebox
bb bench swebench run --n ${N}   <span style="color:var(--faint)"># the public instances above</span>
bb bench run                     <span style="color:var(--faint)"># this repository's open findings</span>
node scripts/benchmark-page.mjs  <span style="color:var(--faint)"># rebuild this page from both</span></code></pre>
  <p>The run writes every instance id it used, so the number can be reproduced or contradicted.</p>
</section>

<footer>
  <p>Built from <code>.bundlebox/bench/swebench/latest.json</code> and <code>.bundlebox/out/bench/latest.json</code> on ${esc(new Date().toISOString().slice(0, 10))}. <a href="../index.html">bundlebox docs</a> · <a href="https://github.com/blackswanalpha/bundlebox">source</a></p>
</footer>
</div>

<script>
(function(){
  var root=document.documentElement,tg=document.getElementById("tgl");
  try{var sv=localStorage.getItem("bb-theme");if(sv)root.setAttribute("data-theme",sv);}catch(e){/* storage blocked: the OS theme applies */}
  tg.addEventListener("click",function(){
    var dark=root.getAttribute("data-theme")==="dark"||(!root.getAttribute("data-theme")&&matchMedia("(prefers-color-scheme:dark)").matches);
    var next=dark?"light":"dark";root.setAttribute("data-theme",next);
    try{localStorage.setItem("bb-theme",next);}catch(e){/* storage blocked: the choice lasts this view only */}
  });

  var tip=document.getElementById("tip");
  function show(el,e){
    tip.innerHTML="<b>"+el.getAttribute("data-k")+"</b>"+el.getAttribute("data-v");
    tip.style.opacity="1";
    var x=e.clientX+14,y=e.clientY+14;
    var r=tip.getBoundingClientRect();
    if(x+r.width>innerWidth-8)x=e.clientX-r.width-14;
    if(y+r.height>innerHeight-8)y=e.clientY-r.height-14;
    tip.style.left=x+"px";tip.style.top=y+"px";
  }
  document.addEventListener("mousemove",function(e){
    var el=e.target.closest?e.target.closest("[data-k]"):null;
    if(el)show(el,e);else tip.style.opacity="0";
  });
  document.addEventListener("mouseleave",function(){tip.style.opacity="0";});

  var tps=document.getElementById("tps"),pf=document.getElementById("pf-note");
  function dur(n){return n>=1000?(Math.round(n/100)/10)+"s":Math.round(n)+"ms";}
  function leg(la,lb,r,tb,tp){
    var a=la+(tb/r)*1000,b=lb+(tp/r)*1000;
    return "<b>"+dur(a)+"</b> bare ("+dur(la)+" + "+dur(a-la)+") against <b>"+dur(b)+"</b> packed ("+dur(lb)+" + "+dur(b-lb)+") \u2014 "
      +(b<a?"bundlebox ahead by "+dur(a-b):"bare ahead by "+dur(b-a));
  }
  function draw(){
    if(!tps||!pf)return;
    var r=+tps.value,d=tps.dataset;
    var L=["DERIVED, not measured \u2014 no request was sent. At "+r.toLocaleString()+" input tokens/s, one task end to end:",
      "<br>\u00b7 in a repo bb has never scanned: "+leg(+d.lbare,+d.lbb,r,+d.bare,+d.bb)];
    if(d.wbb)L.push("<br>\u00b7 in a workspace already scanned: "+leg(+d.wbare,+d.wbb,r,+d.wtbare,+d.wtbb));
    pf.innerHTML=L.join("");
  }
  if(tps){tps.addEventListener("change",draw);draw();}
})();
</script>
</body>
</html>
`;

fs.mkdirSync(path.join(ROOT, "docs", "benchmark"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "benchmark", "index.html"), html);
console.log(`docs/benchmark/index.html — ${N} SWE-bench instance(s), ${lt.measured} local task(s), ${hist.length} recorded run(s)`);
