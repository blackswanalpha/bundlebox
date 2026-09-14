// designlabs/index.js — the verb. A design system is declared as data, derived
// into what a browser renders, and held to floors that are ratios and counts —
// so every sub-verb here except `collect --apply` is a parse over local files
// and costs no tokens. What needs a model (looking at Dribbble, deciding a
// typeface) is written as a brief and handed to the session that chose to pay
// for it; bundlebox never calls one itself.
import fs from "node:fs";
import path from "node:path";
import { load } from "../core/config.js";
import { walk, readText } from "../core/fs.js";
import { out, warn, emit } from "../core/log.js";
import { ROOT, rel } from "../core/paths.js";
import { human, pad, sha1, table } from "../core/util.js";
import * as runner from "../kit/runner.js";
import { cards, card, sources, providersOf, LAB_ROOT } from "./library.js";
import { loadStudio, runRules, tally, failed, VERDICT } from "./check.js";
import * as scaffold from "./scaffold.js";
import * as research from "./research.js";
import { registry, DIR } from "./tables.js";

const cfgOf = () => ({ ...load().designlabs });
const studioDir = (arg) => path.resolve(ROOT, arg || cfgOf().dir || "designlabs");

const MARK = { [VERDICT.pass]: "ok", [VERDICT.fail]: "FAIL", [VERDICT.unknown]: "unknown", [VERDICT.review]: "review", [VERDICT.skip]: "skip" };

async function genericRow(dir) {
  const { runAll } = await import("../detectors/index.js");
  const files = walk(dir);
  if (!files.length) return null;
  const { findings } = runAll({ only: ["ui-generic"], files });
  const tells = findings.filter((f) => f.evidence?.tell && f.evidence.tell !== "count");
  const max = cfgOf().generic_max ?? 2;
  const rows = tells.map((f) => ({ ok: false, text: `${f.evidence.tell}: ${f.title}` }));
  return {
    rule: "generic.tells", card: "anti-generic", severity: "high",
    verdict: tells.length > max ? VERDICT.fail : VERDICT.pass,
    summary: `${tells.length} generic tell${tells.length === 1 ? "" : "s"} in the studio (threshold ${max})`,
    rows,
  };
}

function printRules(rows) {
  for (const r of rows) {
    out(`  ${pad(MARK[r.verdict] || r.verdict, 8)} ${pad(r.rule, 22)} ${r.summary}`);
    if (r.verdict === VERDICT.fail) for (const x of (r.rows || []).filter((y) => y.ok === false).slice(0, 6)) out(`           ${x.text}`);
  }
  const t = tally(rows);
  out("");
  out(`  ${Object.entries(t).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ")}`);
  out("  UNKNOWN is not a pass. REVIEW is a question for a reader, not a verdict.");
}

export const commands = {
  designlabs: {
    help: "the design studio: doctrine, UI research plans, a declared system and the gate that holds it",
    usage: "bb designlabs [status|init|check|tables|plan|collect|intake|sources|principles] [dir] [--apply] [--json]",
    long: `  status            where the studio is and what it declares
  init [dir]        scaffold a studio (dry run without --apply; --force overwrites)
  check [dir]       the gate: contrast ratios, state coverage, motion, targets, generic tells
  tables [build]    the derived tables a session reads instead of the studio
  plan <question>   the research brief an agent with a web tool executes
  collect           fetch the sources bundlebox is allowed to fetch itself (--apply)
  intake            validate what came back into corpus/
  sources [--kind]  the provider registry: what each one answers and what it costs
  principles [id]   the doctrine cards, or one in full`,
    run: async ({ _, flags }) => {
      const sub = _[0] || "status";
      const cfg = cfgOf();

      if (sub === "sources") {
        const s = sources();
        const rows = providersOf(flags.kind || null).map((p) => [p.id, p.kind, p.reach, p.auth, (p.gives || [])[0] || ""]);
        if (flags.json) { emit({ kinds: s.kinds, providers: providersOf(flags.kind || null) }); return 0; }
        out(table(rows, { header: ["id", "kind", "reach", "auth", "answers"] }));
        out("");
        out("  reach: web = hand it to an agent holding a web tool · http = bb fetches it · manual = a human exports it");
        out(`  ${rel(path.join(LAB_ROOT, "sources.json"))} carries the beware and licence line for each.`);
        return 0;
      }

      if (sub === "principles") {
        const id = _[1];
        if (id) {
          const c = card(id);
          if (!c) { warn(`no card "${id}". Have: ${cards().map((x) => x.id).join(", ")}`); return 2; }
          if (flags.json) { emit(c); return 0; }
          out(readText(c.file).trimEnd());
          return 0;
        }
        if (flags.json) { emit({ cards: cards().map(({ body, ...c }) => c) }); return 0; }
        out(table(cards().map((c) => [c.id, c.severity, c.rule, c.check || "review only"]), { header: ["card", "severity", "rule", "checked"] }));
        out(`\n  bb designlabs principles <card> for one in full.`);
        return 0;
      }

      if (sub === "plan") {
        const question = _.slice(1).join(" ");
        if (!question) { warn("bb designlabs plan <what you are designing>"); return 2; }
        const kinds = typeof flags.kinds === "string" ? flags.kinds.split(",").map((s) => s.trim()) : null;
        const rows = research.plan(question, { kinds });
        const text = research.brief(question, rows);
        const dir = studioDir(flags.dir);
        if (flags.json) { emit({ question, rows, brief: text }); return 0; }
        if (flags.write) {
          const p = path.join(dir, "corpus", "PLAN.md");
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, text + "\n");
          out(`  wrote ${rel(p)}  (${human(Math.round(text.length / 4))} tokens)`);
          out("  Hand it to a session with a web tool. bundlebox spent nothing writing it.");
          return 0;
        }
        out(text);
        return 0;
      }

      if (sub === "collect") {
        const dir = studioDir(_[1]);
        const allow = typeof flags.only === "string" ? flags.only.split(",").map((s) => s.trim()) : cfg.fetch_allow || [];
        const rows = await research.collect(dir, { apply: !!flags.apply, allow, query: flags.query || "" });
        if (flags.json) { emit({ rows, apply: !!flags.apply }); return 0; }
        for (const r of rows) out(`  ${pad(r.state, 8)} ${pad(r.id, 14)} ${r.url || r.why || ""}`);
        if (!flags.apply) out("\n  dry run. --apply fetches. Everything else in `bb designlabs sources` needs a web tool.");
        return rows.some((r) => r.state === "error") ? 1 : 0;
      }

      if (sub === "intake") {
        const dir = studioDir(_[1]);
        const rows = research.intake(dir);
        if (flags.json) { emit({ rows }); return 0; }
        if (!rows.length) { out("  corpus is empty. `bb designlabs plan <question> --write` writes the brief that fills it."); return 0; }
        for (const r of rows) out(`  ${pad(r.ok ? "ok" : "FAIL", 6)} ${pad(r.file, 32)} ${r.problems.join("; ")}`);
        const bad = rows.filter((r) => !r.ok).length;
        out(`\n  ${rows.length - bad} usable, ${bad} rejected.`);
        return bad ? 1 : 0;
      }

      if (sub === "init") {
        const dir = studioDir(_[1]);
        const list = scaffold.files(cards());
        if (!flags.apply) {
          out(`  would write ${list.length} files into ${rel(dir)}:`);
          for (const f of list) out(`    ${fs.existsSync(path.join(dir, f.path)) ? "kept   " : "write  "} ${f.path}`);
          out("\n  dry run. --apply writes; --force overwrites what is there.");
          return 0;
        }
        const rows = scaffold.write(dir, cards(), { force: !!flags.force });
        if (flags.json) { emit({ dir: rel(dir), rows }); return 0; }
        for (const r of rows) out(`  ${pad(r.state, 8)} ${r.path}`);
        out(`\n  ${rel(dir)} — open index.html over http://, then \`bb designlabs check\`.`);
        return 0;
      }

      if (sub === "check") {
        const dir = studioDir(_[1]);
        if (!fs.existsSync(dir)) { warn(`no studio at ${rel(dir)}. \`bb designlabs init --apply\` writes one.`); return 2; }
        const st = loadStudio(dir);
        const rows = runRules(st, cfg, await genericRow(dir));
        // The verdicts are this verb's artefact and they do not land in the
        // store, so the count the session bill needs is published here.
        (await import("../learn/episodes.js")).publish({
          screens: st.screens.length, rules: rows.length,
          digest: sha1(rows.map((r) => `${r.rule}:${r.verdict}`).join("|")).slice(0, 12),
        });
        if (flags.json) { emit({ dir: rel(dir), errors: st.errors, rules: rows, tally: tally(rows) }); return failed(rows).length ? 1 : 0; }
        out(`  ${rel(dir)} — ${st.screens.length} screens, ${Object.keys(st.system?.color?.tokens || {}).length} tokens\n`);
        for (const e of st.errors) out(`  FAIL     load                   ${e}`);
        printRules(rows);
        const bad = failed(rows).length + st.errors.length;
        out(`\n  ${bad ? `${bad} failing rule${bad === 1 ? "" : "s"}` : "no failing rules"}. Visual distinctness needs a browser: open ${rel(path.join(dir, "index.html"))} over http://.`);
        return bad ? 1 : 0;
      }

      if (sub === "tables") {
        const dir = studioDir(flags.dir);
        const reg = registry(dir);
        const act = _[1] || "build";
        if (act === "show") {
          const name = _[2];
          if (!name || !reg.has(name)) { warn(`bb designlabs tables show <table>; have ${reg.names().join(", ")}`); return 2; }
          if (!fs.existsSync(reg.path(name))) await runner.build(reg, { only: [name] });
          out(readText(reg.path(name)).trimEnd());
          return 0;
        }
        const rows = act === "stale" ? await runner.stale(reg) : await runner.build(reg, { force: !!flags.force });
        if (flags.json) { emit({ rows, dir: rel(DIR) }); return 0; }
        out(runner.report(reg, rows));
        return rows.some((r) => r.state === "error") ? 1 : 0;
      }

      // status
      const dir = studioDir(_[1]);
      const st = fs.existsSync(dir) ? loadStudio(dir) : null;
      const info = {
        dir: rel(dir), exists: Boolean(st), screens: st?.screens.length || 0,
        tokens: Object.keys(st?.system?.color?.tokens || {}).length,
        corpus: research.intake(dir).length, cards: cards().length, providers: sources().providers.length,
      };
      if (flags.json) { emit(info); return 0; }
      if (!st) {
        out(`  no studio at ${info.dir}.`);
        out(`  ${info.cards} doctrine cards and ${info.providers} sources ship with bundlebox.`);
        out("\n  bb designlabs init --apply     scaffold one");
        out("  bb designlabs principles       what it will be held to");
        return 0;
      }
      out(`  ${info.dir}`);
      out(`    ${info.screens} screens · ${info.tokens} colour tokens · ${info.corpus} corpus entries`);
      out(`    ${info.cards} doctrine cards · ${info.providers} sources`);
      if (st.errors.length) for (const e of st.errors) out(`    ! ${e}`);
      out("\n  bb designlabs check            the gate");
      out("  bb designlabs tables           what a session reads instead of this tree");
      return 0;
    },
  },
};
