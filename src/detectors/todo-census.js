// todo-census — TODO/FIXME/XXX/HACK per top-level directory. A survey, never
// work: a FIXME is somebody's decision already recorded. Its value is that a
// session opening in `src/api/` can be told there are nine FIXMEs there.
import { codeRels, corpus, finding, snippet } from "./_shared.js";

const TODO = /(?:\/\/|#|\/\*|<!--|--|\*)\s*(TODO|FIXME|XXX|HACK)\b[:\s]*(.{0,110})/;
const topDir = (r) => (r.includes("/") ? r.split("/")[0] : ".");

export default {
  name: "todo-census", precision: "exact", severity: "info",
  description: "TODO/FIXME/XXX/HACK markers counted per top-level directory",
  run(ctx) {
    const byDir = new Map();
    const text = corpus(ctx);
    for (const r of codeRels(ctx)) {
      const src = text.get(r);
      if (!/TODO|FIXME|XXX|HACK/.test(src)) continue;
      src.split("\n").forEach((line, i) => {
        const m = TODO.exec(line);
        if (!m) return;
        const d = topDir(r);
        if (!byDir.has(d)) byDir.set(d, []);
        byDir.get(d).push({ file: r, line: i + 1, kind: m[1], text: snippet(m[2], 110) });
      });
    }
    const out = [];
    for (const [dir, items] of [...byDir].sort()) {
      const counts = {};
      for (const h of items) counts[h.kind] = (counts[h.kind] || 0) + 1;
      // FIXME/XXX first: those are bugs somebody already found.
      const top = [...items].sort((a, b) => (/FIXME|XXX/.test(b.kind) - /FIXME|XXX/.test(a.kind))).slice(0, 5);
      out.push(finding({
        severity: "info", kind: "investigate",
        files: [...new Set(top.map((h) => h.file))], path: dir, key: dir,
        title: `${dir}: ${items.length} TODO/FIXME markers (${(counts.FIXME || 0) + (counts.XXX || 0)} FIXME/XXX)`,
        detail: top.map((h) => `  ${h.kind.padEnd(5)} ${h.file}:${h.line}  ${h.text}`).join("\n"),
        evidence: { counts, total: items.length, top },
        fix_hint: "FIXME is a bug somebody already found. Promote those before writing a detector for something nobody has noticed yet.",
      }));
    }
    return out;
  },
};
