#!/usr/bin/env node
// bb — bundlebox. One entrypoint for every verb. Zero dependencies, on purpose:
// a cron worker at 03:00 runs whatever is on disk or it does not run.
import { main } from "../src/cli.js";

// Writes to a pipe are asynchronous, and process.exit drops whatever is still
// queued: `bb findings --json | node …` stopped at 65536 bytes. An empty write's
// callback fires after every earlier write has flushed, so exit waits for it.
const exit = (code) =>
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));

main(process.argv.slice(2)).then(
  (code) => exit(typeof code === "number" ? code : 0),
  (err) => { console.error(`bb: ${err && err.stack ? err.stack : err}`); exit(1); }
);
