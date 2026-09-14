// stale-evidence — open findings whose primary file no longer holds the bytes
// the evidence was computed from. The one detector that reads the store, and
// it earns that by being the only check on the factory's own premise: routing
// a finding against a file that changed spends a session re-deciding it.
// A survey: the action is `bb scan`, and a session cannot be what decides that.
import fs from "node:fs";
import { abs } from "../core/paths.js";
import * as store from "../core/store.js";
import { sha1 } from "../core/util.js";
import { finding } from "./_shared.js";

export default {
  name: "stale-evidence", precision: "exact", severity: "info",
  description: "open findings whose primary file's sha1 differs from the one recorded at scan time",
  run(ctx) {
    const open = store.openFindings().filter((f) => f.evidence?.sha && f.detector !== "stale-evidence");
    if (!open.length) return [];
    const hits = [];
    for (const f of open) {
      const p = abs(f.path);
      let now;
      try { now = fs.statSync(p).isFile() ? sha1(ctx.readText(p)) : null; } catch { now = null; }
      if (now === f.evidence.sha) continue;
      hits.push({ id: f.id, detector: f.detector, path: f.path, title: String(f.title || "").slice(0, 110), gone: now === null });
    }
    if (!hits.length) return [];
    return [finding({
      severity: "info", kind: "verify", path: ".", key: "stale", files: [...new Set(hits.map((h) => h.path))].slice(0, 20),
      title: `${hits.length} open finding(s) name files that changed since they were scanned`,
      detail: hits.slice(0, 15).map((h) => `  ${h.id}  ${h.detector.padEnd(16)} ${h.path}${h.gone ? "  (gone)" : ""}`).join("\n"),
      evidence: { findings: hits.slice(0, 50), count: hits.length },
      fix_hint: "`bb scan` re-derives them against the file as it is now. Do not route a finding whose evidence is a version nobody has.",
    })];
  },
};
