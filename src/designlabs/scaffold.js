// scaffold.js — what `bb designlabs init` writes, and nothing else.
//
// The studio's source of truth is JSON (declared.js) and every rendered file is
// derived from it (assets.js). This file is the manifest: which paths exist,
// what goes in each, and the one rule about overwriting — an existing file is
// KEPT unless --force, because a scaffold that silently replaces a system
// somebody tuned is a scaffold nobody runs twice.
import fs from "node:fs";
import path from "node:path";
import { SYSTEM, SCREEN } from "./declared.js";
import { css, studioJs, indexHtml, statesHtml, selftest } from "./assets.js";

export { SYSTEM, SCREEN } from "./declared.js";

function doctrine(cards) {
  const rows = cards.map((c) => `| \`${c.rule}\` | ${c.title} | ${c.severity} | ${c.check} |`).join("\n");
  return `# Doctrine

Every rule \`bb designlabs check\` enforces, and the card that sets it. The cards
themselves ship with bundlebox under \`designlabs/principles/\`; read one with
\`bb designlabs principles <id>\`.

| rule | principle | severity | what is checked |
|---|---|---|---|
${rows}

Rules marked UNKNOWN by the gate are not failures and are not passes. They are
questions a static pass cannot settle — open \`index.html\` over http:// for the
visual ones, and read the flow for the rest.
`;
}

/** [{path, text}] — every file init writes, so a dry run can list them without
 *  touching the disk. */
export function files(cards) {
  const screenFile = `screens/${SCREEN.id}.json`;
  return [
    { path: "system.json", text: JSON.stringify(SYSTEM, null, 2) + "\n" },
    { path: screenFile, text: JSON.stringify(SCREEN, null, 2) + "\n" },
    { path: "screens/index.json", text: JSON.stringify([`${SCREEN.id}.json`], null, 2) + "\n" },
    { path: "styles/tokens.css", text: css(SYSTEM) },
    { path: "scripts/studio.js", text: studioJs },
    { path: "index.html", text: indexHtml },
    { path: "selftest/contract.mjs", text: selftest },
    { path: "selftest/states.html", text: statesHtml },
    { path: "DOCTRINE.md", text: doctrine(cards) },
    { path: "corpus/README.md", text: `# corpus/

What \`bb designlabs collect\` and \`bb designlabs intake\` write. One JSON file per
reference, in the shape \`bb designlabs intake\` validates:

    { "id", "source", "url", "captured", "kind", "observed": [], "taken": [], "refused": [], "license" }

\`observed\` is what is actually on the page. \`taken\` is what you are carrying into
this system and why. \`refused\` is what you looked at and decided against — the
most useful field, and the one that stops a corpus becoming a mood board.
` },
  ];
}

/** Writes the scaffold. Returns [{path, state:"written"|"kept"}]. */
export function write(dir, cards, { force = false } = {}) {
  const rows = [];
  for (const f of files(cards)) {
    const p = path.join(dir, f.path);
    if (fs.existsSync(p) && !force) { rows.push({ path: f.path, state: "kept" }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text);
    rows.push({ path: f.path, state: "written" });
  }
  return rows;
}
