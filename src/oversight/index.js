// oversight/index.js — the verbs: scan, report, brief, guidelines, thresholds.
// `scan` measures and decides; everything else reads the stored scan, because a
// measurement is seconds and a brief has to be instant.
import { rel } from "../core/paths.js";
import { readText } from "../core/fs.js";
import { out, emit, warn } from "../core/log.js";
import { table } from "../core/util.js";
import * as metrics from "./metrics.js";
import * as rules from "./rules.js";
import * as guidelines from "./guidelines.js";

export { metrics, rules, guidelines };
export const { scan, latest, decide, thresholds, DEFAULT_THRESHOLDS, RULES, DETECTORS } = rules;
export const { brief, agentLines } = guidelines;
export const buildGuidelines = guidelines.build;

const list = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);

export const commands = {
  oversight: {
    help: "measure the tree against its own medians; findings, guidelines, briefs (no tokens)",
    usage: "bb oversight scan [--trees a,b] [--write] [--json] | report | brief <files...> | guidelines [--build] | thresholds",
    run: async ({ _, flags }) => {
      const sub = _[0] || "report";
      if (sub === "scan") {
        const doc = rules.scan({ trees: list(flags.trees), write: !!flags.write });
        if (flags.json) { emit(doc); return 0; }
        out(rules.report(doc));
        out(`\n  wrote ${doc.file}${doc.written ? ` and merged ${doc.findings.length} findings into the store` : "  (dry-run: add --write to store the findings)"}`);
        return 0;
      }
      if (sub === "report") {
        const doc = rules.latest();
        if (!doc) { warn("no scan on file; run `bb oversight scan`"); return 2; }
        if (flags.json) { emit(doc); return 0; }
        out(rules.report(doc, { top: Number(flags.top) || 6 }));
        out(`\n  from ${doc.file || rel(rules.latestPath())} at ${doc.at}`);
        return 0;
      }
      if (sub === "brief") {
        const files = _.slice(1);
        if (!files.length) { warn("bb oversight brief <files...>"); return 2; }
        const text = guidelines.brief(files);
        if (flags.json) { emit({ files, brief: text }); return 0; }
        out(text);
        return 0;
      }
      if (sub === "guidelines") {
        const doc = rules.latest();
        if (!doc) { warn("no scan on file; run `bb oversight scan`"); return 2; }
        if (flags.build) {
          const r = await guidelines.build(doc);
          if (flags.json) { emit({ rows: r.rows, index: rel(r.index), agent_lines: rel(guidelines.agentLinesPath()) }); return 0; }
          for (const row of r.rows) out(`  ${row.state.padEnd(8)} ${row.name.padEnd(20)} ${row.tokens} tok`);
          out(`  index: ${rel(r.index)}\n  paste-ready: ${rel(guidelines.agentLinesPath())} (never inserted for you)`);
          return 0;
        }
        const idx = readText(`${guidelines.DIR}/INDEX.md`);
        if (flags.json) { emit({ index: idx || null, built: !!idx }); return 0; }
        out(idx ? idx.trimEnd() : "  not built; run `bb oversight guidelines --build`");
        return 0;
      }
      if (sub === "thresholds") {
        const t = rules.thresholds();
        if (flags.json) { emit({ thresholds: t, defaults: rules.DEFAULT_THRESHOLDS }); return 0; }
        out(table(Object.entries(t).map(([k, v]) => [k, v, v === rules.DEFAULT_THRESHOLDS[k] ? "" : `(default ${rules.DEFAULT_THRESHOLDS[k]})`]), { header: ["threshold", "value", ""] }));
        out("  `*_x_median` multiplies the tree's own median; `*_floor` is the least the bar can be. Override under `oversight` in .bundlebox/config.json.");
        return 0;
      }
      warn(`unknown sub-verb: ${sub}. ${commands.oversight.usage}`);
      return 2;
    },
  },
};
