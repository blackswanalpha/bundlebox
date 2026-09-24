// secret-scan — credential-shaped strings in files git tracks.
//
// Tracked files only when git is present: an untracked .env is not a leak.
// EVERY match is reported (the original took the first per pattern per file,
// so a script with eight keys read as one), and the value never reaches the
// evidence: a finding is pasted into briefs and logs, and a masked prefix is
// enough to find the line.
import fs from "node:fs";
import path from "node:path";
import { secretSweep } from "../git/repo.js";
import * as filecache from "../core/filecache.js";
import { finding, gitAvailable, isTest, lineIndex, rel, shaOf } from "./_shared.js";

// Vendor prefixes first: a hit is a hit. The generic rules are the net for the
// vendor nobody has a prefix for, and they are the ones the placeholder test
// exists for.
export const PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g, "vendor"],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g, "vendor"],
  ["github token", /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g, "vendor"],
  ["github fine-grained pat", /\bgithub_pat_[0-9A-Za-z_]{22,}\b/g, "vendor"],
  ["slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}/g, "vendor"],
  ["stripe live key", /\b[sr]k_live_[0-9A-Za-z]{20,}\b/g, "vendor"],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/g, "vendor"],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "generic"],
  ["api key literal", /api[_-]?key\s*[:=]\s*['"]([A-Za-z0-9_-]{20,})['"]/gi, "generic"],
];
const PLACEHOLDER = /example|changeme|xxx|your_|<|placeholder|dummy|sample|fake/i;
const TEMPLATE_PATH = /\.(example|template|sample|dist)$|(^|\/)\.env\.example$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|apk|ttf|otf|woff2?|lottie|mp[34]|wasm|so|dylib|exe|bin)$/i;
const B64_RUN = /[A-Za-z0-9+/]{40,}/;

function placeholder(label, klass, src, m, r) {
  const value = m[1] || m[0];
  if (label === "private key") {
    // A header counts only when key material follows it. `stub` is four chars.
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 6000);
    const end = tail.indexOf("-----END");
    return !B64_RUN.test(end > 0 ? tail.slice(0, end) : "");
  }
  if (PLACEHOLDER.test(value)) return true;
  if (TEMPLATE_PATH.test(r)) return true;
  // A test that asserts on a credential-shaped string is a fixture, but only
  // for the SHAPE rules: a real AIza... in a fixture is still a leak.
  if (klass === "generic" && isTest(r)) return true;
  const window = src.slice(Math.max(0, m.index - 80), m.index);
  return /YOUR[_ ]|PLACEHOLDER|CHANGE[_ ]?ME|EXAMPLE|FAKE|DUMMY/i.test(window);
}
const mask = (v) => v.slice(0, 4) + "****";

function candidates(ctx) {
  if (gitAvailable(ctx)) {
    const r = ctx.git(["ls-files", "-z"]);
    if (r.rc === 0) return r.out.split("\0").filter(Boolean).map((n) => path.join(ctx.root, n));
  }
  return ctx.files;
}

export default {
  name: "secret-scan", precision: "probe", severity: "critical",
  description: "credential-shaped strings in tracked files, every hit, value masked",
  run(ctx) {
    const out = [];
    // The corpus when an earlier detector already read it; building it here
    // would read every walked file for a `--only secret-scan` run.
    const text = ctx._cache?.corpus;
    for (const p of candidates(ctx)) {
      if (BINARY.test(p)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; } // vanished since listing
      if (!st.isFile() || st.size > 2_000_000) continue;
      const r = rel(p);
      const src = text?.get(r) ?? ctx.readText(p);
      // Every input to a hit is this file's path and bytes, so the hits are too.
      const hits = filecache.derived(r, shaOf(ctx, r, src), "secrets", () => {
        let lineOf = null;   // built on the first hit: almost every file has none
        const found = [];
        for (const [label, re, klass] of PATTERNS) {
          for (const m of src.matchAll(re)) {
            if (placeholder(label, klass, src, m, r)) continue;
            lineOf ??= lineIndex(src);
            found.push({ path: r, line: lineOf(m.index), kind: label, masked: mask(m[1] || m[0]) });
          }
        }
        return found;
      });
      if (!hits.length) continue;
      out.push(finding({
        severity: "critical", files: [r], key: r,
        // Keeps the file out of the NEXT commit. It closes nothing: a key that
        // reached a remote is public whatever .gitignore says.
        auto_fix: secretSweep([r]).length ? "ignore-secret-file" : null,
        title: `${r}: ${hits.length} secret-shaped string(s) in a tracked file`,
        detail: hits.slice(0, 15).map((h) => `  ${h.kind.padEnd(24)} ${h.path}:${h.line}  ${h.masked}`).join("\n"),
        evidence: { hits: hits.slice(0, 60), count: hits.length, tracked: gitAvailable(ctx) },
        fix_hint: "Rotate first, then remove. A key that reached a remote is already public whatever the next commit says.",
      }));
    }
    return out;
  },
};
