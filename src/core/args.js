// args.js — a tiny argv parser. `bb verb [sub] --flag value --bool -x positional`
// Returns { _: [positionals], flags: {name: value|true}, rest: [after --] }.
export function parse(argv) {
  const out = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { out.flags[camel(a.slice(2, eq))] = coerce(a.slice(eq + 1)); continue; }
      const name = camel(a.slice(2));
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) { out.flags[name] = coerce(next); i++; }
      else out.flags[name] = true;
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) { for (const c of a.slice(1)) out.flags[c] = true; continue; }
    out._.push(a);
  }
  return out;
}
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const coerce = (v) => (v === "true" ? true : v === "false" ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
