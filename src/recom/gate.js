// gate.js — run the expensive thing only if its answer has stopped holding.
//
//   bb recom gate <id> -- <command>
//
// `bb recom check` reports a verdict and a human decides. This is the same
// verdict wired directly to the decision, so a script, a CI job or an agent
// that cannot be trusted to read a table still cannot drive a phone that did
// not need driving:
//
//   fresh                print the answer, run NOTHING, exit 0
//   stale | unknown      run the command, say which fact moved
//   missing              run the command, and say how to record it afterwards
//
// The asymmetry is deliberate and it is the whole safety property. A gate that
// is wrong in the `fresh` direction hands back an answer about a world that
// moved, and nothing downstream can tell. A gate that is wrong the other way
// costs one extra run. So anything that is not provably fresh runs.
//
// `--force` runs regardless, which is what a person does when they do not
// believe the record.
import { spawnSync } from "node:child_process";
import { out, warn, emit } from "../core/log.js";
import { check, get } from "./index.js";

/** Decide, then act. Returns what happened, so `--json` and the table share one
 *  code path and cannot disagree. */
export function gate(id, argv, { force = false, apply = true, before = null } = {}) {
  const rec = get(id);
  const verdict = rec ? check(id) : { id, verdict: "missing", moved: [], unreadable: [] };
  const wouldRun = force || verdict.verdict !== "fresh";

  const decision = {
    id, verdict: verdict.verdict, forced: Boolean(force),
    moved: verdict.moved || [], unreadable: verdict.unreadable || [],
    command: argv.join(" "),
    ran: false, rc: null,
    // What NOT running is worth, from the record itself. Only meaningful when
    // the record is fresh: a stale record saves nothing, because the run has to
    // happen anyway.
    saved_wall_s: !wouldRun ? (rec?.saved_wall_s || 0) : 0,
    saved_tokens: !wouldRun ? (rec?.saved_tokens || 0) : 0,
  };

  if (!wouldRun) return { ...decision, answer: { title: rec.title, outcome: rec.outcome, summary: rec.summary, steps: rec.steps, evidence: rec.evidence, recorded: rec.recorded } };
  if (!argv.length) return { ...decision, why: "nothing after `--` to run" };
  if (!apply) return { ...decision, state: "would run" };

  // Why it is running is printed BEFORE it runs. The command inherits stdio, so
  // a caller that reported afterwards would show the output first and the
  // reason underneath it, which reads as though the reason were a result.
  if (before) before(decision);

  // stdio inherited: the command being gated is the interesting output, and
  // capturing it would make this verb a second, worse terminal.
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", shell: false });
  return { ...decision, ran: true, rc: r.status ?? (r.error ? 127 : 1), error: r.error ? String(r.error.message) : "" };
}

export async function cmd({ _, flags, rest }) {
  const id = _[1];
  if (!id) { warn("bb recom gate <id> -- <command>"); return 2; }
  const argv = rest || [];
  const say = (d) => {
    if (flags.json) return;
    const why = d.forced ? "--force" : d.verdict === "missing" ? "no record" : d.verdict;
    out(`  ${why}${d.moved.length ? `: ${d.moved.map((m) => m.probe).join(", ")} moved` : d.unreadable.length ? `: ${d.unreadable.map((u) => u.probe).join(", ")} unreadable` : ""}`);
    for (const m of d.moved) out(`    ${m.probe}\n      was ${m.was}\n      now ${m.now}`);
    for (const u of d.unreadable) out(`    ${u.probe}: ${u.why}`);
    out(`  running: ${d.command}\n`);
  };
  const r = gate(id, argv, { force: !!flags.force, apply: flags.dryRun !== true, before: say });

  if (flags.json) { emit(r); return r.ran ? r.rc : 0; }

  if (!r.ran && r.verdict === "fresh" && !r.forced) {
    out(`  fresh  ${id} — every declared fact reads as it did, so nothing ran.`);
    out(`\n  ${r.answer.title}`);
    out(`  outcome: ${r.answer.outcome}`);
    out(`  ${r.answer.summary}`);
    if (r.answer.evidence?.length) out(`\n  evidence: ${r.answer.evidence.join(", ")}`);
    out(`\n  recorded ${r.answer.recorded}. Skipped: ${r.command || "(no command given)"}`);
    if (r.saved_wall_s || r.saved_tokens) out(`  not spent: ${Math.round(r.saved_wall_s / 60)} min and ~${Math.round(r.saved_tokens / 1000)}k tokens.`);
    out(`\n  --force runs it anyway.`);
    return 0;
  }

  if (!r.command) { warn("nothing after `--` to run"); return 2; }
  if (r.state === "would run") {
    const why = r.forced ? "--force" : r.verdict === "missing" ? "no record" : r.verdict;
    out(`  ${why}\n  would run: ${r.command}`);
    return 0;
  }
  if (r.error) { warn(r.error); return r.rc; }
  if (r.rc === 0) {
    out(`\n  it worked. Record it so the next session does not pay for it again:`);
    out(`    bb recom template ${id} > run.json   # then fill in depends, summary, saved_*`);
    out(`    bb recom record --from run.json --apply`);
    if (r.verdict === "stale") out(`    bb recom refresh ${id} --apply   # if the answer is unchanged and only the facts moved`);
  }
  return r.rc;
}

