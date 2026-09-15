// auditor/menu.js — the bar itself, as data: the ten domains, the assurance
// levels, the standards, the refuse-list and the register.
//
// Separated from `standards.js` because these are two different kinds of thing
// and they change for different reasons. This file is CONTENT — what good looks
// like, written once and argued with rarely. `standards.js` is the MECHANISM —
// how a tree's own signals decide which of these rows apply to it. Editing the
// bar should not mean reading the selector, and vice versa.
//
// Codes (`SEC-1`, `REL-4`) are quoted in recorded findings, so renaming one
// breaks every finding that cites it. Treat them as an API: add rows, retire
// rows, do not renumber them.
/** The ten domains. Codes are stable and are quoted in findings, so renaming
 *  one breaks every recorded finding that cites it — treat them as an API. */
export const DOMAINS = {
  SEC: "Security — what an attacker with each level of access could reach",
  PRV: "Privacy — what personal data is held, why, and who can read it",
  A11Y: "Accessibility — whether a person not using a mouse and a 20/20 eye can work",
  I18N: "Internationalisation — whether text, dates, money and sort order survive another locale",
  PERF: "Performance — what gets slow, at what size, and what the cost is made of",
  REL: "Reliability — what happens when a dependency is down, slow, or lying",
  MNT: "Maintainability — whether the next reader can change this safely",
  OBS: "Observability — whether a failure in production can be explained from outside",
  DOC: "Documentation — whether what is written is true today",
  SHIP: "Release engineering — whether the artefact that reaches a user is the one that was built",
};

/** Assurance levels. The consequence of a defect sets the level; the level sets
 *  verification depth and who must sign. It never turns an invariant off. */
export const ADAL = {
  A: { title: "catastrophic", why: "a defect loses money, corrupts an audit trail, or cannot be undone",
    coverage: 95, independent_review: true, adversarial: "mandatory",
    examples: "a ledger, a payment reconcile, a payroll calculation, a migration that drops data" },
  B: { title: "hazardous", why: "a defect exposes data, breaks authorisation, or silently changes a record",
    coverage: 95, independent_review: true, adversarial: "on the isolation and authorisation paths",
    examples: "tenancy, auth and RBAC, a public webhook, grade or score integrity, PII surfaces" },
  C: { title: "major", why: "correctness matters and the blast radius is bounded",
    coverage: 80, independent_review: false, adversarial: "not required",
    examples: "scaffolding, an internal screen, a report, a CLI verb" },
};

/** `check` is what a reader does to decide the bar is met. `detector` is the
 *  local verb that already computes part of it — where one exists, the brief
 *  hands its output to the agent instead of asking for it. */
export const STANDARDS = [
  // ── SEC ───────────────────────────────────────────────────────────────────
  { id: "SEC-1", domain: "SEC", title: "No secret reaches version control",
    bar: "No credential, token, private key or connection string exists in a tracked file, a fixture, or a log line.",
    check: "grep the tree and the last 50 commits for high-entropy strings and known key shapes",
    detector: "secret-scan", evidence: "code reference", when: "always", adal: "B" },
  { id: "SEC-2", domain: "SEC", title: "Every external input is validated at the boundary",
    bar: "Input from a user, a webhook or another service is parsed into a typed shape before any code branches on it. Nothing is interpolated into SQL, a shell, or HTML.",
    check: "read every handler that reads a request body and name the schema it parses to",
    detector: "", evidence: "code reference", when: "surfaces", adal: "B" },
  { id: "SEC-3", domain: "SEC", title: "Authorisation is decided server-side, per request",
    bar: "A role or claim from a client is never trusted. The decision is made in the service layer against the record being touched, not in a route guard.",
    check: "pick three write endpoints and trace who is allowed to call them and where that is decided",
    detector: "", evidence: "code reference", when: "auth", adal: "B" },
  { id: "SEC-4", domain: "SEC", title: "The dependency tree is accounted for",
    bar: "Every direct dependency is used, pinned by a lockfile that matches the manifest, and has no known critical advisory.",
    check: "the lockfile parses, resolves the manifest, and nothing declared is unimported",
    detector: "dead-deps,lockfile-drift", evidence: "CI artefact", when: "always", adal: "C" },
  { id: "SEC-5", domain: "SEC", title: "The trust boundary is drawn and both sides are named",
    bar: "Every process boundary — IPC, FFI, a socket, a subprocess, a plugin host — has a written list of what crosses it and what is refused.",
    check: "list the boundaries; for each, name the allowlist and what happens to a message not on it",
    detector: "", evidence: "design artefact", when: "boundary", adal: "A" },

  // ── PRV ───────────────────────────────────────────────────────────────────
  { id: "PRV-1", domain: "PRV", title: "Personal data is inventoried",
    bar: "Every field that identifies a person is listed with why it is held, how long, and who can read it.",
    check: "read the data model and produce the list; a field nobody can justify is a finding",
    detector: "", evidence: "design artefact", when: "pii", adal: "B" },
  { id: "PRV-2", domain: "PRV", title: "Personal data does not reach logs or telemetry",
    bar: "No log line, error report, crash dump or analytics event carries a name, a number, an address, a token or a free-text field a person wrote.",
    check: "grep every log call in the paths that handle a person and read what is interpolated",
    detector: "debug-leftovers", evidence: "code reference", when: "pii", adal: "B" },

  // ── A11Y ──────────────────────────────────────────────────────────────────
  { id: "A11Y-1", domain: "A11Y", title: "Every interactive element is reachable and named without a mouse",
    bar: "Tab order follows reading order, focus is visible, and every control has an accessible name.",
    check: "walk the primary flow with the keyboard only and record where it dead-ends",
    detector: "", evidence: "manual check", when: "ui", adal: "C" },
  { id: "A11Y-2", domain: "A11Y", title: "Colour is never the only carrier of meaning, and contrast holds",
    bar: "Body text meets 4.5:1 and large text 3:1 in both themes; a red/green distinction is also a shape or a word.",
    check: "measure the palette pairs actually used, in both themes",
    detector: "ui-generic", evidence: "manual check", when: "ui", adal: "C" },

  // ── I18N ──────────────────────────────────────────────────────────────────
  { id: "I18N-1", domain: "I18N", title: "User-visible text is not concatenated from fragments",
    bar: "A sentence a person reads is one string with named parameters, not two strings joined by code.",
    check: "grep for string addition and template joins in the presentation layer",
    detector: "", evidence: "code reference", when: "i18n", adal: "C" },
  { id: "I18N-2", domain: "I18N", title: "Time, money and sort order carry their own type",
    bar: "A timestamp carries a zone, money carries a currency and a decimal type, and sorting a list of names uses a collator.",
    check: "find every float used for money and every naive datetime crossing a boundary",
    detector: "", evidence: "code reference", when: "money", adal: "A" },

  // ── PERF ──────────────────────────────────────────────────────────────────
  { id: "PERF-1", domain: "PERF", title: "There is a budget, and it is measured against a floor from the same run",
    bar: "The primary request has a stated budget expressed as a multiple of the floor measured on the box it ran on, so a slower machine is not a regression.",
    check: "run the simulation and compare p95 to the budget derived in that run",
    detector: "", evidence: "test result", when: "service", adal: "C" },
  { id: "PERF-2", domain: "PERF", title: "No unbounded work on a hot path",
    bar: "No query in a loop, no full scan where an index exists, no read of an unbounded collection into memory to count it.",
    check: "read the three hottest handlers and name the growth of each in the size of the data",
    detector: "", evidence: "code reference", when: "service", adal: "B" },

  // ── REL ───────────────────────────────────────────────────────────────────
  { id: "REL-1", domain: "REL", title: "Every external call has a timeout, a bound on retries, and a defined failure",
    bar: "No call to a network, a subprocess or a disk waits forever. A retry loop is bounded and backs off. What the caller sees when it finally fails is written down.",
    check: "list every outbound call and name its timeout; a call with none is a finding",
    detector: "", evidence: "code reference", when: "network", adal: "B" },
  { id: "REL-2", domain: "REL", title: "Anything that can be delivered twice is idempotent",
    bar: "A replayed webhook, a retried job or a double-submitted form does not apply twice. The key that makes it safe is named.",
    check: "for each externally-triggered mutation, name the idempotency key and where it is enforced",
    detector: "", evidence: "test result", when: "network", adal: "A" },
  { id: "REL-3", domain: "REL", title: "State that matters survives a crash at the worst moment",
    bar: "A write is atomic or journalled. Killing the process mid-write leaves the previous good state, not a truncated one.",
    check: "find every write of durable state and say whether it is atomic; a plain write of a whole file is not",
    detector: "", evidence: "test result", when: "state", adal: "A" },
  { id: "REL-4", domain: "REL", title: "Concurrent writers cannot lose each other's work",
    bar: "Every read-modify-write of shared state is serialised by a lock, a compare-and-swap, or an append-only log. Two processes doing the same thing at once is the normal case, not the exotic one.",
    check: "list every read-modify-write of a shared file, row or key and name what serialises it",
    detector: "", evidence: "code reference", when: "state", adal: "A" },

  // ── MNT ───────────────────────────────────────────────────────────────────
  { id: "MNT-1", domain: "MNT", title: "No file does more than one thing",
    bar: "A file past the tree's own limit is not big, it is doing too much. Split by responsibility, not by line count.",
    check: "the god-file and big-file detectors, then read the worst one and name its two jobs",
    detector: "god-file,big-file", evidence: "code reference", when: "always", adal: "C" },
  { id: "MNT-2", domain: "MNT", title: "Nothing is dead",
    bar: "No unreachable branch, unused export, commented-out block or abstraction with one caller. Deleted, not commented out — the history is in version control.",
    check: "the dead-exports and orphan-files detectors, then confirm each is genuinely unreferenced",
    detector: "dead-exports,orphan-files", evidence: "code reference", when: "always", adal: "C" },
  { id: "MNT-3", domain: "MNT", title: "The third duplication is a refactor",
    bar: "The second copy is a warning and the third is a defect. An abstraction earns its keep at the third use, not the first.",
    check: "the duplicate-blocks detector, then judge whether the copies will diverge",
    detector: "duplicate-blocks", evidence: "code reference", when: "always", adal: "C" },
  { id: "MNT-4", domain: "MNT", title: "A comment says why, and is true",
    bar: "Comments explain the non-obvious reason — a legal rule, an ordering constraint, a workaround. A comment that restates the line is deleted. An outdated comment is worse than none.",
    check: "read the comments in the area's two largest files and mark each: why, what, or wrong",
    detector: "anti-slop", evidence: "code reference", when: "always", adal: "C" },
  { id: "MNT-5", domain: "MNT", title: "The change is covered by a test that would have failed before it",
    bar: "Every behaviour change carries a test. A state machine carries a test for the illegal transition, not only the legal one.",
    check: "the missing-tests detector, then confirm the named tests actually exercise the path",
    detector: "missing-tests", evidence: "test result", when: "always", adal: "C" },

  // ── OBS ───────────────────────────────────────────────────────────────────
  { id: "OBS-1", domain: "OBS", title: "A failure in production can be explained without a debugger",
    bar: "Every error path logs enough to identify the request, the actor and the decision — and nothing more.",
    check: "pick a plausible production failure and trace what a reader would have, from logs alone",
    detector: "", evidence: "manual check", when: "service", adal: "C" },
  { id: "OBS-2", domain: "OBS", title: "A health check answers without reading the thing it reports on",
    bar: "A liveness probe does not fail because a store is mid-write. Readiness and liveness are different questions and have different routes.",
    check: "read the health route and name everything it touches",
    detector: "", evidence: "code reference", when: "service", adal: "C" },

  // ── DOC ───────────────────────────────────────────────────────────────────
  { id: "DOC-1", domain: "DOC", title: "Every claim in the docs is true today",
    bar: "A number, a command or a path in a document either matches the tree or is marked as an example. A link resolves.",
    check: "the doc-links and doc-drift detectors over every document that makes a claim",
    detector: "doc-links,doc-drift", evidence: "CI artefact", when: "always", adal: "C" },
  { id: "DOC-2", domain: "DOC", title: "A reader can get from clone to running in the README alone",
    bar: "The first page names the prerequisites, the install, the one command that proves it works, and what to do when that fails.",
    check: "follow the README on a clean box and record the first step that does not work",
    detector: "", evidence: "manual check", when: "always", adal: "C" },

  // ── SHIP ──────────────────────────────────────────────────────────────────
  { id: "SHIP-1", domain: "SHIP", title: "There is one command that proves a change",
    bar: "A single declared command decides whether a change is acceptable. Nothing ships `unproven`.",
    check: "run the declared gate on a clean checkout and record the exit code",
    detector: "", evidence: "CI artefact", when: "always", adal: "C" },
  { id: "SHIP-2", domain: "SHIP", title: "The working tree is not the release",
    bar: "The artefact is built from a committed ref, and the version it reports matches the tag it was built from.",
    check: "the worktree-hygiene detector, then compare the reported version to the tag",
    detector: "worktree-hygiene", evidence: "CI artefact", when: "always", adal: "C" },
  { id: "SHIP-3", domain: "SHIP", title: "A release can be undone",
    bar: "There is a documented way back to the previous version, including for anything the new version wrote to durable state.",
    check: "name the rollback path; a migration with no down path is a finding",
    detector: "", evidence: "design artefact", when: "state", adal: "A" },
];

export const byId = (id) => STANDARDS.find((s) => s.id === id) || null;

/** The prohibited list an agent carries into P4. A superset of the anti-patterns
 *  the standards imply, restated as a refuse-list because "do not do X" is a
 *  cheaper instruction to follow than "satisfy standard SEC-2". */
export const PROHIBITED = [
  "a credential, token or statutory rate written into source",
  "SQL, a shell command or HTML built by string concatenation from input",
  "a bare catch that swallows the error",
  "an unbounded retry loop, or any outbound call with no timeout",
  "a read-modify-write of shared state with nothing serialising it",
  "a float for money",
  "a non-idempotent consumer of an externally-triggered event",
  "editing an append-only record in place",
  "a second ad-hoc HTTP client beside the one the tree already has",
  "a file past the tree's own size limit",
  "dead or commented-out code left behind",
  "an API or a dependency that was not verified to exist before it was used",
  "a gate disabled or an assertion weakened to make a run go green",
];

/** The never/always register. Short on purpose: a register nobody can recite is
 *  a document, and a document does not constrain a session. */
export const BCR = {
  never: [
    "work outside the scope statement without stopping and saying so",
    "disable, skip or weaken a gate to reach green",
    "claim a result that was not measured",
    "leave a finding without evidence a reader can check",
    "invent an API, a flag or a file path — verify it exists first",
  ],
  always: [
    "confirm the scope before the first edit",
    "bind every change to one acceptance criterion",
    "write the test in the same change as the code",
    "say which numbers are measured and which are estimated, and never add them",
    "stop and ask when the work leaves the operating domain",
  ],
};

