#!/usr/bin/env node
// bb — bundlebox. One entrypoint for every verb. Zero dependencies, on purpose:
// a cron worker at 03:00 runs whatever is on disk or it does not run.
import { main } from "../src/cli.js";
main(process.argv.slice(2)).then(
  (code) => process.exit(typeof code === "number" ? code : 0),
  (err) => { console.error(`bb: ${err && err.stack ? err.stack : err}`); process.exit(1); }
);
