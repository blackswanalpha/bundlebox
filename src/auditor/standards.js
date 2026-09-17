// auditor/standards.js — which rows of the bar apply to THIS tree, and why.
//
// The bar itself lives in `menu.js`. This file is the selector: it reads signals
// the tree already emits — does it take money, hold records about people, bind a
// socket, cross a process boundary — and returns the standards those signals
// imply, each carrying the signal that pulled it in. Nobody ticks boxes, and a
// selection somebody disagrees with is arguable rather than mysterious.
//
// Scope says what to look at. This says what GOOD looks like when you look at
// it. It is a MENU, not a checklist: a CLI for one person and a multi-tenant
// service that holds money do not get the same audit, and a framework that
// applies every row to every tree teaches people to ignore rows.
//
// Three properties make this worth having instead of a prose document:
//
//   1. **Selection is risk-based and derived.** `select()` reads signals the
//      tree already emits — does it take money, does it hold PII, does it ship
//      a binary, does it have a UI — and returns the standards those signals
//      imply, with the signal that pulled each one in. Nobody ticks boxes.
//
//   2. **A standard names who checks it.** `detector` binds a standard to a
//      local verb that already computes part of it. The auditor never asks a
//      model for a number a detector produces for free; it asks for the half
//      that is judgement. That is the whole economic argument for this module.
//
//   3. **A standard names its evidence.** A finding against a standard with no
//      evidence type is an opinion, and the ingest refuses it.
//
// ADAL (assurance level) scales rigour to consequence, from DO-178B by way of
// AAS-SDF: it changes verification DEPTH and who signs, never whether an
// invariant applies.
import { load as loadCfg } from "../core/config.js";
import { readText } from "../core/fs.js";
import { abs } from "../core/paths.js";

export { DOMAINS, ADAL, STANDARDS, PROHIBITED, BCR, byId } from "./menu.js";
import { STANDARDS, ADAL } from "./menu.js";

// ── selection ───────────────────────────────────────────────────────────────

/** Content markers. Paths tell you most of what an area is, but not all of it:
 *  a module called `console` binds a socket and a module called `server`
 *  may only hold types. PROBE_FILES caps the read so the whole-tree case stays
 *  cheap; per-area it reads everything, which is a few dozen files.
 *
 *  Each marker names the signal it raises AND the line that raised it, so a
 *  selection a reader disagrees with can be argued with rather than guessed at. */
export const PROBE_FILES = 150;
const MARKERS = [
  ["service", /createServer\(|app\.(get|post|listen)\(|@(Get|Post|Route)Mapping|http\.HandleFunc|urlpatterns|FastAPI\(|express\(/, "it binds or routes HTTP"],
  ["network", /\bfetch\(|axios\.|requests\.(get|post)|http\.request|reqwest::|urlopen\(/, "it calls out over the network"],
  ["auth", /authoriz|authenticat|\bjwt\b|bearer |permission|csrf|\brbac\b/i, "it decides who may do what"],
  ["state", /INSERT INTO|UPDATE .+ SET|DELETE FROM|createTable|\bmigrations?\b|\.(save|persist|commit)\(\)|sqlite|postgres|mongo/i, "it owns a record of durable state"],
  ["money", /\b(amount|currency|invoice|payout|charge|refund)\b/i, "it handles money-shaped values"],
  ["boundary", /spawn(Sync)?\(|child_process|ffi|postMessage\(|WebSocket|ipcMain|dlopen/, "it crosses a process or language boundary"],
];

/** Comments, strings and regex literals stripped out.
 *
 *  A signal is supposed to say what an area DOES. Probing raw text says what it
 *  MENTIONS, and those are not the same thing — this module's own menu of
 *  standards names "payment", "ledger" and "payroll" inside a regex literal,
 *  which put the auditor itself at assurance level A for handling money it has
 *  never touched. A framework that miscalibrates on its own source would
 *  miscalibrate on any file that documents what it guards against.
 *
 *  The stripping is a lexer's job done with regexes, and it over-strips rather
 *  than under-strips on purpose: a missed signal shows up as a standard nobody
 *  selected, which is visible and arguable, and a false one shows up as an
 *  assurance level nobody can explain. */
export function codeOnly(src) {
  const TRIPLE = new RegExp(String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''`, "g");
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ")                  // /* block */
    .replace(TRIPLE, " ")                                 // python docstrings
    .replace(/^\s*(\/\/|#|\*).*$/gm, " ")                 // line comments
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, " ")        // template literals
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ") // quoted strings
    .replace(/\/(?![*/])(?:\\.|\[[^\]]*\]|[^/\\\n])+\/[gimsuy]*/g, " "); // regex literals
}

function probeContent(files) {
  const found = {};
  for (const f of files.slice(0, PROBE_FILES)) {
    if (!/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|php|java|kt|swift|dart|cs)$/.test(f)) continue;
    const raw = readText(abs(f), "");
    if (!raw) continue;
    const src = codeOnly(raw);
    for (const [key, re, why] of MARKERS) if (!found[key] && re.test(src)) found[key] = `${why} (\`${f}\`)`;
    if (Object.keys(found).length === MARKERS.length) break;
  }
  return found;
}

/** What the tree says about itself, read from what is already on disk. These
 *  are the inputs to `select`; each one is a fact, not a guess, and the answer
 *  carries the file that produced it so a wrong selection is arguable. */
export const SOURCE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|php|java|kt|swift|dart|cs|vue|svelte|sql)$/;
export function signals({ files = [], world = null, findings = [], area = "" } = {}) {
  // Path signals are read from SOURCE files only. A signal says what an area
  // does, and `docs/prices.md` is a document about money rather than a thing
  // that moves it — counting it put a documentation folder at assurance level A.
  const code = files.filter((f) => SOURCE.test(f));
  const has = (re) => code.some((f) => re.test(f));
  const joined = code.join("\n");
  // A surface counts for THIS area only when the world model names this area.
  // Counting every surface in the tree would put a docs folder on the same
  // footing as the request handler, which is how a calibrated framework turns
  // back into a checklist.
  const surface = (world?.surfaces || []).find((s) => s.id === area) || null;
  const sig = {};
  const add = (k, on, why) => { if (on) sig[k] = why; };
  add("always", true, "every tree gets these");
  add("ui", /\.(tsx|jsx|vue|svelte|dart|swift|kt)$/m.test(joined) || has(/(^|\/)(components?|screens?|views?|pages?)\//),
    "the tree has a presentation layer");
  add("service", Boolean(surface) || has(/(^|\/)(routes?|handlers?|controllers?|api|server)\//) || has(/(^|\/)(main|server|app)\.(js|ts|py|go|rs)$/),
    surface ? `the world model names this a surface (${surface.id})` : "it has request handlers");
  add("network", /\b(fetch\(|axios|requests\.|http\.request|reqwest|urllib)\b/.test(joined) || has(/(^|\/)(client|adapters?|integrations?)\//),
    "it calls something it does not control");
  add("auth", has(/(^|\/)(auth|session|login|rbac|permission|identity)/i), "it decides who may do what");
  add("pii", has(/(^|\/)(user|profile|patient|student|customer|account|member)s?[./]/i), "it holds records about people");
  add("money", has(/(^|\/)(payment|billing|invoice|ledger|payroll|price|checkout|wallet)/i), "it moves or records money");
  add("state", has(/(^|\/)(store|db|database|migrations?|models?|persistence|repositor)/i), "it owns durable state");
  add("boundary", has(/(^|\/)(ipc|ffi|bridge|native|plugin|worker|kernel)/i), "it has a process or language boundary");
  add("i18n", has(/(^|\/)(locales?|i18n|translations?|lang)\//), "it ships more than one locale");
  // Paths first, then content: a path match is cheap and a content match is
  // definite, so content wins the `why` where the two agree on the signal.
  for (const [k, why] of Object.entries(probeContent(files))) sig[k] = why;
  if (findings.some((f) => f.detector === "secret-scan" && f.status === "open")) sig.secret_open = "a secret-scan finding is open";
  return sig;
}

/** The standards this tree's own signals pull in, each with the signal that did
 *  it. `force` adds ids by hand; `drop` removes them, and a dropped standard is
 *  an EXCEPTION that the charter records with a reason — never a silent gap. */
export function select({ files = [], world = null, findings = [], area = "", force = [], drop = [] } = {}) {
  const sig = signals({ files, world, findings, area });
  const rows = [];
  for (const s of STANDARDS) {
    const forced = force.includes(s.id) || force.includes(s.domain);
    const why = sig[s.when];
    if (!why && !forced) continue;
    if (drop.includes(s.id) || drop.includes(s.domain)) continue;
    rows.push({ ...s, because: forced ? "selected by hand" : why });
  }
  return { signals: sig, standards: rows,
    domains: [...new Set(rows.map((r) => r.domain))].sort(),
    dropped: STANDARDS.filter((s) => drop.includes(s.id) || drop.includes(s.domain)).map((s) => s.id) };
}

/** The level this area is audited at.
 *
 *  Driven by the SIGNALS, not by the highest adal among the selected standards.
 *  Those two differ and the difference matters: "no secret in version control"
 *  is a B-depth standard and it applies to every tree, so taking the maximum
 *  would put a docs folder at level B and calibration would mean nothing. The
 *  level is about what a defect HERE costs, which is what the signals say.
 */
export function levelOf(selected, sig = {}) {
  const A = ["money", "state", "boundary"].filter((k) => sig[k]);
  const B = ["auth", "pii", "service"].filter((k) => sig[k]);
  const level = A.length ? "A" : B.length ? "B" : "C";
  return { level, ...ADAL[level],
    driven_by: (A.length ? A : B.length ? B : ["nothing in this area raises it above the floor"])
      .map((k) => sig[k] ? `${k} — ${sig[k]}` : k),
    // The standards that demand this depth, for a reader who wants to see which
    // rows the level actually changes.
    deepest: selected.filter((s) => s.adal === level).map((s) => s.id) };
}

/** The coverage floor and gate list this workspace actually declares, so the
 *  charter quotes the tree rather than a number from a document. */
/** The gate list this workspace actually declares, so a charter quotes the tree
 *  rather than a number out of a document. Deduplicated by COMMAND: `quick` and
 *  `lint` bound to the same line are one gate under two names, and printing it
 *  twice makes a reader think two things ran. */
export function gates() {
  const g = loadCfg().kernel?.gates || {};
  const byCmd = new Map();
  for (const [name, v] of Object.entries(g)) {
    if (!v || name === "source") continue;
    const cmd = String(v);
    if (byCmd.has(cmd)) byCmd.get(cmd).names.push(name);
    else byCmd.set(cmd, { cmd, names: [name] });
  }
  return [...byCmd.values()].map((x) => ({ name: x.names.join("/"), cmd: x.cmd }));
}
