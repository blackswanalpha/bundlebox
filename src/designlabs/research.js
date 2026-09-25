// research.js — the two ways evidence gets into a corpus.
//
// `plan` costs nothing and calls nothing: it turns one design question into the
// exact queries, per source, that an agent holding a web tool should run, plus
// the schema it must bring the answers back in. bundlebox does not browse
// Dribbble — the gallery is JS-rendered and its terms forbid it — so the honest
// division is that bb writes the plan and validates the return, and the agent
// with the web tool does the looking. That keeps the expensive half billable to
// the session that chose to spend it.
//
// `collect` is the small set bb CAN fetch itself: sources whose terms allow it
// and whose answers are machine-readable. It is a dry run until --apply.
import fs from "node:fs";
import path from "node:path";
import { now } from "../core/util.js";
import { providersOf, provider, cards } from "./library.js";

/** What a corpus entry must carry. `refused` is the field that stops a corpus
 *  turning into a mood board: what you looked at and decided against. */
export const ENTRY_KEYS = ["id", "source", "url", "captured", "kind", "observed", "taken", "refused", "license"];

const QUERY_SHAPES = {
  shots: ["{q} ui", "{q} app interface", "{q} dashboard"],
  flows: ["{q}", "{q} onboarding", "{q} empty state", "{q} error state"],
  sites: ["{q}", "{q} landing page"],
  systems: ["{q} component", "{q} state layer", "{q} motion duration"],
  principles: ["{q} usability", "{q} cognitive load", "{q} research"],
  type: ["{q} typeface pairing", "{q} editorial type"],
  color: ["{q} palette"],
  motion: ["{q} easing", "{q} transition duration"],
  access: ["{q} contrast", "{q} target size"],
};

/** The plan: [{provider, kind, reach, queries, url, bring, beware, license}]. */
export function plan(question, { kinds = null, perSource = 3 } = {}) {
  const q = String(question || "").trim();
  if (!q) throw new Error("bb designlabs plan <what you are designing>");
  const wanted = kinds && kinds.length ? kinds : ["flows", "shots", "sites", "systems", "principles", "type", "access"];
  const rows = [];
  for (const kind of wanted) {
    for (const p of providersOf(kind)) {
      const shapes = (QUERY_SHAPES[kind] || ["{q}"]).slice(0, perSource);
      rows.push({
        provider: p.id, name: p.name, kind, reach: p.reach, auth: p.auth,
        url: p.url,
        queries: shapes.map((s) => s.replace("{q}", q)),
        search: p.search ? shapes.map((s) => p.search.replace("{q}", encodeURIComponent(s.replace("{q}", q)))) : [],
        bring: p.gives || [], beware: p.beware || "", license: p.license || "",
      });
    }
  }
  return rows;
}

/** The brief an agent is handed. Prose, because the reader is a model, and
 *  ordered so the refusals land before the sources rather than after. */
export function brief(question, rows) {
  const web = rows.filter((r) => r.reach === "web");
  const http = rows.filter((r) => r.reach === "http");
  const manual = rows.filter((r) => r.reach === "manual");
  const normative = cards().filter((c) => c.severity === "critical" || c.severity === "high");
  const L = [];
  L.push(`# Design research: ${question}`);
  L.push("");
  L.push("You are collecting evidence for a design system, not collecting pictures.");
  L.push("Every entry you write must say what you REFUSED as well as what you took;");
  L.push("an entry with an empty `refused` array is a bookmark, not research.");
  L.push("");
  L.push("## The floors that outrank everything you will find");
  L.push("");
  for (const c of normative) L.push(`- **${c.title}** (\`${c.rule}\`) — ${c.check}`);
  L.push("");
  L.push("A source that contradicts one of these is wrong, however good it looks.");
  L.push("");
  L.push("## Sources that need your web tool");
  L.push("");
  for (const r of web) {
    L.push(`### ${r.name} — ${r.kind}`);
    L.push(`Queries: ${r.queries.map((x) => `\`${x}\``).join(", ")}`);
    if (r.search.length) L.push(`Start at: ${r.search[0]}`);
    L.push(`Take: ${r.bring.join("; ")}`);
    L.push(`Beware: ${r.beware}`);
    L.push(`Licence: ${r.license}`);
    L.push("");
  }
  if (http.length) {
    L.push("## Sources bundlebox fetches itself");
    L.push("");
    L.push(`\`bb designlabs collect --apply\` retrieves ${http.map((r) => r.name).join(", ")}. Do not spend turns on these.`);
    L.push("");
  }
  if (manual.length) {
    L.push("## Behind a paywall");
    L.push("");
    for (const r of manual) L.push(`- ${r.name}: ${r.beware}`);
    L.push("");
  }
  L.push("## What to write back");
  L.push("");
  L.push("One JSON file per reference under `corpus/`, named `<source>-<slug>.json`:");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify({
    id: "mobbin-linear-inbox", source: "mobbin", url: "https://…", captured: now().slice(0, 10),
    kind: "flows",
    observed: ["rows are 56px with a 12px inner gap and a 28px section gap", "empty state names the next action, not the absence"],
    taken: ["the inner/outer gap ratio, because our own worklist groups by whitespace"],
    refused: ["their accent on both the active nav and the unread badge — von-restorff says one accent, and theirs marks nothing"],
    license: "reference only",
  }, null, 2));
  L.push("```");
  L.push("");
  L.push("Then run `bb designlabs intake corpus/` — it validates the shape and refuses an entry that only says what it liked.");
  return L.join("\n");
}

const FETCHABLE = {
  fontsource: (q) => `https://api.fontsource.org/v1/fonts?family=${encodeURIComponent(q || "")}`,
  wcag: () => "https://www.w3.org/WAI/WCAG22/quickref/",
  lawsofux: () => "https://lawsofux.com/",
  "motion-dev": () => "https://motion.dev/docs/quick-start",
};

/** Fetch the allowlisted sources. Dry run unless apply. Returns rows. */
export async function collect(dir, { apply = false, allow = [], query = "", timeout = 15000 } = {}) {
  const rows = [];
  for (const id of allow) {
    const p = provider(id);
    const mk = FETCHABLE[id];
    if (!p || !mk) { rows.push({ id, state: "skip", why: "not in the fetchable set" }); continue; }
    const url = mk(query);
    if (!apply) { rows.push({ id, state: "dry", url }); continue; }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "bundlebox designlabs (+https://github.com/blackswanalpha/bundlebox)" } });
      const body = await res.text();
      if (!res.ok) { rows.push({ id, state: "error", url, why: `HTTP ${res.status}` }); continue; }
      const out = path.join(dir, "corpus", `${id}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })(); // not JSON: stored raw
      fs.writeFileSync(out, JSON.stringify({
        id, source: id, url, captured: now(), kind: p.kind,
        observed: parsed ? [`${Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length} records`] : [`${body.length} bytes of html`],
        taken: [], refused: [], license: p.license,
        payload: parsed ?? body.slice(0, 20000),
      }, null, 2) + "\n");
      rows.push({ id, state: "written", url, bytes: body.length, path: path.join("corpus", `${id}.json`) });
    } catch (e) {
      rows.push({ id, state: "error", url, why: String(e?.message || e) });
    } finally { clearTimeout(timer); }
  }
  return rows;
}

/** Validate corpus entries. [{file, ok, problems:[]}] */
export function intake(dir) {
  const cdir = path.join(dir, "corpus");
  if (!fs.existsSync(cdir)) return [];
  return fs.readdirSync(cdir).filter((n) => n.endsWith(".json")).sort().map((n) => {
    const p = path.join(cdir, n);
    let e;
    try { e = JSON.parse(fs.readFileSync(p, "utf8")); } catch (err) { return { file: n, ok: false, problems: [`not JSON: ${err.message}`] }; }
    const problems = [];
    for (const k of ENTRY_KEYS) if (!(k in e)) problems.push(`missing "${k}"`);
    for (const k of ["observed", "taken", "refused"]) if (k in e && !Array.isArray(e[k])) problems.push(`"${k}" is not an array`);
    if (Array.isArray(e.observed) && e.observed.length === 0) problems.push("observed is empty: nothing was actually looked at");
    if (Array.isArray(e.refused) && e.refused.length === 0 && Array.isArray(e.taken) && e.taken.length > 0) {
      problems.push("took something and refused nothing: a bookmark, not research");
    }
    return { file: n, ok: problems.length === 0, problems, kind: e.kind || "?", source: e.source || "?" };
  });
}
