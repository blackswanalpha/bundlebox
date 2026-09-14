// _diff.js — a unified diff with no dependency. Every actuator writes one to
// var/patches BEFORE it touches a file, so a wrong edit is `git apply -R` away
// and a dry run has something to show.
function lcsTable(a, b) {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t;
}
/** [{op:" "|"-"|"+", line}] between two arrays of lines. Common prefix and
 *  suffix are peeled first so the quadratic table only covers the change. */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ma = a.slice(pre, a.length - suf), mb = b.slice(pre, b.length - suf);
  const ops = a.slice(0, pre).map((line) => ({ op: " ", line }));
  const t = lcsTable(ma, mb);
  let i = 0, j = 0;
  while (i < ma.length || j < mb.length) {
    if (i < ma.length && j < mb.length && ma[i] === mb[j]) { ops.push({ op: " ", line: ma[i] }); i++; j++; }
    else if (j < mb.length && (i >= ma.length || t[i][j + 1] >= t[i + 1][j])) { ops.push({ op: "+", line: mb[j] }); j++; }
    else { ops.push({ op: "-", line: ma[i] }); i++; }
  }
  for (const line of a.slice(a.length - suf)) ops.push({ op: " ", line });
  return ops;
}
export function unifiedDiff(oldText, newText, { from = "a", to = "b", context = 3 } = {}) {
  if (oldText === newText) return "";
  const ops = diffLines(oldText.split("\n"), newText.split("\n"));
  const out = [`--- ${from}`, `+++ ${to}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === " ") { i++; continue; }
    const start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while the next change is within 2*context lines.
    for (let k = i; k < ops.length; k++) { if (ops[k].op !== " ") end = k; else if (k - end > 2 * context) break; }
    end = Math.min(ops.length - 1, end + context);
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < start; k++) { if (ops[k].op !== "+") oldStart++; if (ops[k].op !== "-") newStart++; }
    const slice = ops.slice(start, end + 1);
    const oldN = slice.filter((o) => o.op !== "+").length, newN = slice.filter((o) => o.op !== "-").length;
    out.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@`);
    for (const o of slice) out.push(o.op + o.line);
    i = end + 1;
  }
  return out.join("\n") + "\n";
}
