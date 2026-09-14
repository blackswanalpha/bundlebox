// lockfile-drift — a manifest and its lockfile disagreeing, or no lockfile.
// A survey: which lockfile a project commits is a decision, and `npm install`
// is not a session. Reported so the router knows a fresh checkout will not
// reproduce this tree's dependency set.
import fs from "node:fs";
import path from "node:path";
import { finding, packageJson, readTextAt } from "./_shared.js";

const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
const PY_LOCKS = ["uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock"];

export default {
  name: "lockfile-drift", precision: "exact", severity: "low",
  description: "package.json/pyproject/Cargo.toml versus their lockfiles: missing, or versions that disagree",
  run(ctx) {
    const out = [];
    const has = (n) => fs.existsSync(path.join(ctx.root, n));
    const emit = (o) => out.push(finding({ kind: "investigate", ...o }));
    const pj = packageJson(ctx);
    if (pj) {
      const declared = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
      const present = NPM_LOCKS.filter(has);
      if (Object.keys(declared).length && !present.length) {
        emit({ severity: "low", files: ["package.json"], key: "npm:missing", title: "package.json declares dependencies but no lockfile is committed",
          evidence: { declared: Object.keys(declared).length, looked_for: NPM_LOCKS },
          fix_hint: "Commit the lockfile your package manager writes; a fresh checkout resolves a different tree without it." });
      }
      if (has("package-lock.json")) {
        let lock = null;
        try { lock = JSON.parse(readTextAt(ctx, "package-lock.json")); } catch { /* unparsable: reported below */ }
        const root = lock?.packages?.[""];
        if (!lock) emit({ severity: "low", files: ["package-lock.json"], key: "npm:unparsable", title: "package-lock.json is not valid JSON", evidence: { parsed: false } });
        else if (root) {
          const locked = { ...(root.dependencies || {}), ...(root.devDependencies || {}) };
          const mismatch = [], missing = [];
          for (const [n, v] of Object.entries(declared)) {
            if (!(n in locked)) missing.push(n);
            else if (locked[n] !== v) mismatch.push({ name: n, manifest: v, lock: locked[n] });
          }
          if (mismatch.length || missing.length) {
            emit({ severity: "medium", files: ["package.json", "package-lock.json"], key: "npm:drift",
              title: `package-lock.json disagrees with package.json: ${mismatch.length} version(s), ${missing.length} missing`,
              detail: [...mismatch.map((m) => `  ${m.name}: ${m.manifest} vs ${m.lock}`), ...missing.map((n) => `  ${n}: not in lock`)].slice(0, 20).join("\n"),
              evidence: { mismatch: mismatch.slice(0, 50), missing: missing.slice(0, 50), count: mismatch.length + missing.length },
              fix_hint: "`npm install` rewrites the lock to match; commit both." });
          }
        }
      }
      if (has("yarn.lock")) {
        const y = readTextAt(ctx, "yarn.lock");
        const missing = Object.keys(declared).filter((n) => !y.includes(`"${n}@`) && !y.includes(`\n${n}@`) && !y.startsWith(`${n}@`));
        if (missing.length) emit({ severity: "medium", files: ["package.json", "yarn.lock"], key: "yarn:drift", title: `yarn.lock lacks ${missing.length} declared dependenc${missing.length === 1 ? "y" : "ies"}`,
          detail: missing.slice(0, 20).map((n) => `  ${n}`).join("\n"), evidence: { missing: missing.slice(0, 50), count: missing.length }, fix_hint: "`yarn install` then commit the lock." });
      }
    }
    if (has("pyproject.toml")) {
      const t = readTextAt(ctx, "pyproject.toml");
      const declares = /^\s*dependencies\s*=\s*\[/m.test(t) || /\[tool\.poetry\.dependencies\]/.test(t);
      if (declares && !PY_LOCKS.some(has) && !has("requirements.txt")) {
        emit({ severity: "low", files: ["pyproject.toml"], key: "py:missing", title: "pyproject.toml declares dependencies but no lockfile is committed",
          evidence: { looked_for: PY_LOCKS }, fix_hint: "`uv lock` or `poetry lock`; commit the result." });
      }
    }
    if (has("Cargo.toml")) {
      const t = readTextAt(ctx, "Cargo.toml");
      if (/\[dependencies\]/.test(t) && !has("Cargo.lock")) {
        emit({ severity: "info", files: ["Cargo.toml"], key: "cargo:missing", title: "Cargo.toml declares dependencies but Cargo.lock is not committed",
          evidence: { looked_for: ["Cargo.lock"] }, fix_hint: "Binaries commit Cargo.lock; libraries usually do not. Decide, then ignore this or add the lock." });
      }
    }
    return out;
  },
};
