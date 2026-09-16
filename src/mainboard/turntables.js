// mainboard/turntables.js — put the record on again.
//
// `bb cookbook run` answers "does the system obey its rules RIGHT NOW" and
// stores the board. Twenty of those boards sit under `.bundlebox/var/boards/`
// and nothing has ever read the second-newest one. That history is the only
// place two facts live, and neither is visible in any single run:
//
//   A scenario that changed its mind. Green, red, green over three runs nobody
//   changed the corpus between. A session handed the red board spends its turns
//   on a defect that was not there twenty minutes ago and will not be there
//   twenty minutes from now, which is the most expensive shape of work this
//   factory can hand anybody.
//
//   A scenario that went green to red and stayed there. That is a regression,
//   and the run it entered on is on disk — so the finding can name the window
//   rather than asking somebody to go and find it.
//
// This view runs NOTHING. `cookbook` owns the corpus and pays for the requests;
// every tick of the `scenarios` gear leaves another board behind, and turning
// that pile into the two findings above costs a file read. The replay is free
// because somebody else already paid for it.
//
// The definition digest is what keeps this honest. A verdict that changed
// because somebody edited the scenario is not a flake and must never be filed
// as one, so every comparison carries a hash of what the scenario ASKED — its
// question, its rule block and its step names — and a change in that hash
// explains the change in verdict instead of accusing the system.
import crypto from "node:crypto";

const RED = new Set(["failed", "error"]);
const GREEN = new Set(["passed"]);

/** What the scenario asked, hashed. Not what it answered: a digest over the
 *  results would change on every run and explain every flake away. */
export function definition(sc) {
  const shape = {
    question: sc.question || "",
    rule: Array.isArray(sc.rule) ? sc.rule : sc.rule ? [sc.rule] : [],
    severity: sc.severity || "",
    steps: (sc.steps || []).map((s) => `${s.kind || ""} ${s.name || ""} ${s.request || ""}`),
  };
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 12);
}

const verdict = (sc) => (RED.has(sc.state) ? "red" : GREEN.has(sc.state) ? "green" : sc.state || "unknown");
const firstRed = (sc) => (sc.steps || []).find((s) => RED.has(s.state)) || null;

/** The verdict sequence per scenario, across the boards it appears in.
 *
 *  Only scenarios present in BOTH ends of a comparison are compared. A partial
 *  run — `bb cookbook run --only auth` — stores a board with nine scenarios of
 *  twenty-two, and treating the thirteen it never touched as "gone" would file
 *  thirteen regressions against a system nobody changed. */
export function tracks(history) {
  const byId = new Map();
  for (const b of history) {
    for (const sc of b.scenarios || []) {
      const t = byId.get(sc.id) || { id: sc.id, surface: sc.surface || "", title: sc.title || sc.id, severity: sc.severity || "medium", runs: [] };
      t.runs.push({ at: b.at || "", verdict: verdict(sc), def: definition(sc), red: firstRed(sc),
        statuses: (sc.steps || []).map((s) => `${s.name || ""}=${s.status ?? ""}`) });
      t.surface = sc.surface || t.surface;
      t.severity = sc.severity || t.severity;
      byId.set(sc.id, t);
    }
  }
  return [...byId.values()];
}

/** A transition the definition does not explain. */
function transitions(runs) {
  const out = [];
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1], b = runs[i];
    if (a.verdict === b.verdict) continue;
    out.push({ from: a.verdict, to: b.verdict, at: b.at, edited: a.def !== b.def });
  }
  return out;
}

/** A step whose status code varied while the scenario kept saying green. The
 *  scenario asserted something weaker than what the system actually does, and
 *  nothing else on the board can see it. */
function unstableSteps(runs) {
  if (runs.length < 2) return [];
  const seen = new Map();
  for (const r of runs) {
    for (const s of r.statuses) {
      const i = s.lastIndexOf("=");
      if (i < 0) continue;
      const name = s.slice(0, i), status = s.slice(i + 1);
      if (!status) continue;
      (seen.get(name) || seen.set(name, new Set()).get(name)).add(status);
    }
  }
  return [...seen.entries()].filter(([, v]) => v.size > 1).map(([name, v]) => ({ step: name, statuses: [...v].sort() }));
}

/** Every finding this view can make, from boards alone. */
export function replay(history, { corpus = "" } = {}) {
  const ts = tracks(history);
  const findings = [];
  let flaky = 0, regressions = 0, changes = 0, edited = 0;

  for (const t of ts) {
    if (t.runs.length < 2) continue;
    const tr = transitions(t.runs);
    changes += tr.length;
    const unexplained = tr.filter((x) => !x.edited);
    edited += tr.length - unexplained.length;
    const last = t.runs[t.runs.length - 1], prev = t.runs[t.runs.length - 2];
    const seq = t.runs.map((r) => r.verdict).join(" → ");

    // Flake first, and it wins over regression: a scenario that has changed its
    // mind twice is not red, it is unreliable, and filing it as a defect sends
    // somebody after a system that is behaving.
    if (unexplained.length >= 2) {
      flaky += 1;
      findings.push({ id: `TT-${corpus}-${t.id}-flake`.slice(0, 80), category: "RACE", severity: "high",
        title: `${t.surface}: ${t.title} changed its mind ${unexplained.length} times over ${t.runs.length} runs`,
        detail: `The scenario was not edited between those runs — its question, rule block and step names hash the same — so the verdict is not stable and neither colour of it can be trusted. A red board carrying this row costs a session the time to chase a defect that may not be there; a green one hides it. Fix the scenario's determinism (ordering, a clock, a shared fixture) before reading either verdict.`,
        evidence: { corpus, scenario: t.id, sequence: seq, runs: t.runs.length,
          changes: unexplained.map((x) => `${x.from}→${x.to} at ${x.at}`), definition: last.def },
        case: t.id, refers: "cookbook", target: "local" });
      continue;
    }

    if (prev.verdict === "green" && last.verdict === "red" && prev.def === last.def) {
      regressions += 1;
      const r = last.red;
      findings.push({ id: `TT-${corpus}-${t.id}-regression`.slice(0, 80), category: "CONTRACT", severity: t.severity,
        title: `${t.surface}: ${t.title} was green last run and is red now`,
        detail: `The scenario is unchanged. It passed at ${prev.at} and failed at ${last.at}, so the window that broke it is between those two runs.${r ? ` First red step: ${r.name || "?"}.` : ""}`,
        evidence: { corpus, scenario: t.id, passed_at: prev.at, failed_at: last.at, sequence: seq,
          request: r?.request || null, why: r?.why || null, status: r?.evidence?.status ?? null, got: r?.evidence?.got ?? null },
        case: t.id, refers: "cookbook", target: "local" });
      continue;
    }

    // Green throughout and still not deterministic. Weaker than a flake and
    // filed separately, because the fix is in the assertion, not in the system.
    if (t.runs.every((r) => r.verdict === "green")) {
      const wobble = unstableSteps(t.runs);
      if (wobble.length) {
        findings.push({ id: `TT-${corpus}-${t.id}-unstable`.slice(0, 80), category: "RACE", severity: "medium",
          title: `${t.surface}: ${t.title} passes with ${wobble.length} step(s) that answer differently run to run`,
          detail: `Every run of this scenario was green, and ${wobble.map((w) => `\`${w.step}\` returned ${w.statuses.join(" and ")}`).join("; ")}. The assertion is weaker than the behaviour: it accepts both, so the day one of them is wrong the board will still be green.`,
          evidence: { corpus, scenario: t.id, steps: wobble.slice(0, 6), runs: t.runs.length },
          case: t.id, refers: "cookbook", target: "local" });
      }
    }
  }

  const replayed = ts.filter((t) => t.runs.length >= 2).length;
  return { findings, facts: { runs: history.length, scenarios_replayed: replayed, verdict_changes: changes,
    explained_by_edit: edited, flaky, regressions,
    stable_pct: replayed ? Math.round(((replayed - flaky) / replayed) * 100) : null,
    window: history.length ? `${history[0].at} → ${history[history.length - 1].at}` : "" } };
}
