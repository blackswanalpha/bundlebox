// drivers/adb.js — a device over adb, by resource id.
//
// The same shape as the page driver, over `adb shell`. Resource ids and not
// screenshots: a screenshot has to be read by something, and the thing that
// reads it is a model call per step, which is what this whole file exists to
// avoid. `uiautomator dump` is text, the ids in it are the app's own, and
// matching one is a string comparison.
//
// No corpus in this workspace has run on a phone. What is unproven here is
// whether an id survives a rebuild well enough for the replay to stay free;
// when one does not, the step reds about the corpus and the lesson row records
// it, exactly as a renamed route does today.
import { run as execRun, which } from "../../core/exec.js";

export const id = "adb";
export const available = () => (which("adb") ? { ok: true } : { ok: false, why: "adb is not on PATH" });

const adb = (s, args, timeout = 20000) => execRun(["adb", ...(s.serial ? ["-s", s.serial] : []), ...args], { timeout });

export async function open({ base = "" } = {}, target) {
  const a = available();
  if (!a.ok) throw new Error(a.why);
  const s = { serial: process.env.BB_ADB_SERIAL || "", base, dump: "" };
  if (target) await act(s, { verb: "open", target });
  return s;
}

/** The current window as text. Re-dumped before every assertion, because a
 *  stale dump is an assertion about the screen two actions ago. */
function dump(s) {
  const r = adb(s, ["shell", "uiautomator dump /dev/tty"]);
  s.dump = r.rc === 0 ? r.out : "";
  return s.dump;
}

const node = (s, selector) => {
  const want = String(selector).replace(/^#/, "");
  const rx = new RegExp(`<node[^>]*resource-id="[^"]*${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`);
  const m = rx.exec(s.dump || dump(s));
  if (!m) return null;
  const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(m[0]);
  return { raw: m[0], centre: b ? [Math.round((+b[1] + +b[3]) / 2), Math.round((+b[2] + +b[4]) / 2)] : null };
};

export async function act(s, a) {
  if (a.verb === "open") {
    const r = /^[\w.]+\/[\w.]+$/.test(a.target)
      ? adb(s, ["shell", "am", "start", "-n", a.target])
      : adb(s, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", a.target]);
    s.dump = "";
    return r.rc === 0 ? { ok: true, got: { started: a.target } } : { ok: false, why: `am start ${a.target}: ${(r.err || r.out).trim().slice(-200)}` };
  }
  if (a.verb === "click" || a.verb === "type") {
    const n = node(s, a.selector);
    if (!n) return { ok: false, why: `no node with resource-id \`${a.selector}\`` };
    if (!n.centre) return { ok: false, why: `\`${a.selector}\` has no bounds to tap` };
    const tap = adb(s, ["shell", "input", "tap", String(n.centre[0]), String(n.centre[1])]);
    if (tap.rc !== 0) return { ok: false, why: `tap ${a.selector}: ${(tap.err || tap.out).trim().slice(-200)}` };
    s.dump = "";
    if (a.verb === "click") return { ok: true, got: { tapped: a.selector } };
    const t = adb(s, ["shell", "input", "text", String(a.text).replace(/ /g, "%s")]);
    return t.rc === 0 ? { ok: true, got: { typed: a.selector } } : { ok: false, why: `input text: ${(t.err || t.out).trim().slice(-200)}` };
  }
  s.dump = "";
  const screen = dump(s);
  if (a.what === "text") {
    return screen.includes(a.text) ? { ok: true, got: {} }
      : { ok: false, why: `the screen does not contain ${JSON.stringify(a.text)}`, got: { nodes: screen.length } };
  }
  const n = node(s, a.selector);
  if (a.what === "visible") return n ? { ok: true, got: { bounds: n.centre } } : { ok: false, why: `no node with resource-id \`${a.selector}\`` };
  return n ? { ok: false, why: `\`${a.selector}\` is on screen, expected absent` } : { ok: true, got: {} };
}

export async function close() { /* the device stays where it is */ }
