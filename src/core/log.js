// log.js — everything the user sees goes through here so --json and --quiet
// can be honoured in one place.
let quiet = false, json = false;
export const setMode = ({ quiet: q = false, json: j = false } = {}) => { quiet = q; json = j; };
export const isJson = () => json;
export const out = (...s) => { if (!quiet && !json) console.log(...s); };
export const warn = (...s) => { if (!quiet) console.error("  !", ...s); };
export const emit = (obj) => { if (json) console.log(JSON.stringify(obj, null, 2)); };
export const hr = (n = 60) => out("  " + "-".repeat(n));
