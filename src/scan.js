// scan.js — the verbs that cost nothing: scan, findings, explain, fix.
// A scan is a set of parses and set differences over the tree (doctrine 1); the
// store keeps findings keyed by a stable id so a re-scan updates instead of
// duplicating, and `fix` reaches the local actuators before any session does.
import * as store from "./core/store.js";
import { emit, out, warn } from "./core/log.js";
import { load } from "./core/config.js";
import { human, table } from "./core/util.js";
import { REGISTRY, SEVERITY, explain, runAll, triage } from "./detectors/index.js";
import { ACTUATORS, DESTRUCTIVE, actuate } from "./actuators/index.js";

const worst = (fs) => fs.reduce((w, f) => ((SEVERITY[f.severity] ?? 0) > (SEVERITY[w] ?? -1) ? f.severity : w), "");
const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export const commands = {
  scan: {
    help: "run the local detectors (no tokens)",
    usage: "bb scan [--only a,b] [--json]",
    run: async ({ flags }) => {
      const only = list(flags.only);
      const unknown = only.filter((n) => !REGISTRY[n]);
      if (unknown.length) { warn(`no such detector: ${unknown.join(", ")}`); return 2; }
      const t0 = Date.now();
      const { findings, ran } = runAll({ only });
      const detectors = new Set(ran.filter((r) => !r.error).map((r) => r.name));
      const merged = store.mergeFindings(findings, { detectors });
      const open = merged.filter((f) => f.status === "open");
      const fresh = open.filter((f) => f.seen_count === 1 && detectors.has(f.detector));
      const resolved = merged.filter((f) => f.status === "resolved" && detectors.has(f.detector) && f.resolved_at && Date.parse(f.resolved_at) >= t0);
      const promoted = open.filter((f) => triage(f).promote);
      store.put("scan", { at: new Date().toISOString(), ms: Date.now() - t0, ran, open: open.length, new: fresh.length, resolved: resolved.length, promotable: promoted.length });
      if (flags.json) { emit({ ran, open: open.length, new: fresh.length, resolved: resolved.length, promotable: promoted.length, findings: open }); return 0; }
      if (!fresh.length && !resolved.length && ran.every((r) => !r.error)) {
        out(`  nothing new since the last scan: ${open.length} open, ${promoted.length} promotable (${Date.now() - t0} ms)`);
        return 0;
      }
      const rows = ran.map((r) => {
        const mine = open.filter((f) => f.detector === r.name);
        return [r.name, r.error ? "ERROR" : String(mine.length), r.error ? r.error.slice(0, 60) : worst(mine) || "-", r.ms];
      });
      out(table(rows, { header: ["detector", "open", "worst", "ms"] }));
      out(`  ${open.length} open, ${fresh.length} new, ${resolved.length} resolved, ${promoted.length} promotable — ${Date.now() - t0} ms`);
      return 0;
    },
  },
  findings: {
    help: "list findings",
    usage: "bb findings [--detector x] [--severity s] [--status open|resolved|fixed|wontfix|all] [--limit n] [--json]",
    run: async ({ flags }) => {
      const status = flags.status || "open";
      const limit = Number(flags.limit) || 50;
      let rows = store.get("findings", []);
      if (status !== "all") rows = rows.filter((f) => f.status === status);
      if (flags.detector) rows = rows.filter((f) => list(flags.detector).includes(f.detector));
      if (flags.severity) rows = rows.filter((f) => (SEVERITY[f.severity] ?? 0) >= (SEVERITY[flags.severity] ?? 0));
      rows.sort((a, b) => (SEVERITY[b.severity] ?? 0) - (SEVERITY[a.severity] ?? 0) || a.detector.localeCompare(b.detector));
      const shown = rows.slice(0, limit);
      if (flags.json) { emit({ count: rows.length, findings: shown }); return 0; }
      if (!rows.length) { out(`  no ${status} findings`); return 0; }
      out(table(shown.map((f) => [f.id, f.severity, f.detector, triage(f).promote ? "P" : f.auto_fix ? "A" : "", human(f.est_tokens || 0), String(f.title).slice(0, 80)]),
        { header: ["id", "sev", "detector", "", "tokens", "title"] }));
      if (rows.length > shown.length) out(`  ${rows.length - shown.length} more; --limit ${rows.length} to see all`);
      return 0;
    },
  },
  explain: {
    help: "one finding: evidence and the triage derivation",
    usage: "bb explain <id> [--json]",
    run: async ({ _, flags }) => {
      const id = _[0];
      const f = store.get("findings", []).find((x) => x.id === id || (id && x.id.startsWith(id)));
      if (!f) { warn(`no finding ${id || "(no id given)"}`); return 2; }
      const cfg = load();
      if (flags.json) { emit({ finding: f, triage: triage(f, cfg) }); return 0; }
      out(`  ${f.id}  ${f.detector}  ${f.severity} (${f.precision})  ${f.status}`);
      out(`  ${f.title}`);
      out(`  path ${f.path}  files ${f.files.length}  est ${human(f.est_tokens || 0)} tokens  kind ${f.kind}  seen ${f.seen_count}× since ${f.first_seen}`);
      if (f.detail) out("\n" + f.detail.split("\n").map((l) => "  " + l).join("\n"));
      if (f.fix_hint) out(`\n  fix: ${f.fix_hint}`);
      if (f.auto_fix) out(`  actuator: ${f.auto_fix}`);
      out("\n  evidence:");
      out(JSON.stringify(f.evidence, null, 2).split("\n").map((l) => "    " + l).join("\n"));
      out("\n  " + explain(f, cfg).split("\n").join("\n  "));
      return 0;
    },
  },
  fix: {
    help: "run local actuators over findings that name one (dry run without --apply)",
    usage: "bb fix [--apply] [--detector x] [--id id] [--force] [--json]",
    run: async ({ flags }) => {
      const cfg = load();
      const apply = !!flags.apply;
      let rows = store.openFindings().filter((f) => f.auto_fix);
      if (flags.detector) rows = rows.filter((f) => list(flags.detector).includes(f.detector));
      if (flags.id) rows = rows.filter((f) => f.id === flags.id || f.id.startsWith(String(flags.id)));
      // Every open finding that names an actuator, promotable or not. The
      // severity floor and the expected-value floor exist to ration lane
      // tokens; an actuator spends none, so gating it on promotion would leave
      // a low-severity broken link open forever while its fix costs nothing.
      // Judgement findings are reached here and only here, never by promotion.
      const results = [];
      for (const f of rows) {
        if (!ACTUATORS[f.auto_fix]) { results.push({ id: f.id, name: f.auto_fix, ok: false, why: "no such actuator", declined: [] }); continue; }
        if (DESTRUCTIVE.has(f.auto_fix) && !flags.force) { results.push({ id: f.id, name: f.auto_fix, ok: false, why: "destructive; pass --force", declined: [] }); continue; }
        const r = actuate(f, { apply, cfg });
        results.push({ id: f.id, detector: f.detector, path: f.path, ...r });
        if (apply && (r.changed || r.planned)) {
          // A finding closes when an actuator FIXED it. A plan derived what the
          // decision needs and decided nothing, and `keeps_open` is an actuator
          // saying it acted and left work owed — a secret is still unrotated
          // whatever .gitignore now says. Both stay open, both are recorded.
          if (r.changed && !r.keeps_open) {
            const all = store.get("findings", []);
            const me = all.find((x) => x.id === f.id);
            if (me) { me.status = "fixed"; me.fixed_at = new Date().toISOString(); me.fixed_by = f.auto_fix; store.put("findings", all); }
          }
          store.append("episodes", { kind: r.planned ? "plan" : "actuator", verb: f.auto_fix, rc: r.ok ? 0 : 1, produced: r.patch, finding: f.id });
        }
      }
      if (flags.json) { emit({ apply, results }); return 0; }
      if (!results.length) { out("  nothing to fix: no open finding names an actuator"); return 0; }
      for (const r of results) {
        const verdict = r.planned ? (r.applied ? "PLANNED" : "would plan") : r.changed ? (r.applied ? "APPLIED" : "would change") : r.ok ? "no change" : "FAILED";
        out(`  ${r.id}  ${String(r.name).padEnd(26)} ${verdict.padEnd(13)} ${r.why}${r.patch ? `  ${r.planned ? "plan" : "patch"} ${r.patch}` : ""}`);
        for (const d of r.declined || []) out(`      declined ${d.path}: ${d.reason}`);
      }
      if (!apply && results.some((r) => r.changed || r.planned)) out("  dry run; re-run with --apply to write");
      return results.every((r) => r.ok) ? 0 : 1;
    },
  },
};
