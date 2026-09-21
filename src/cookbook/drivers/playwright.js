// drivers/playwright.js — a real browser, when this box has one.
//
// Playwright is NOT a dependency of bundlebox and never will be: a cron worker
// at 03:00 runs whatever is on disk. It is imported at run time, and a box
// without it gets one `blocked` step saying so rather than a corpus that
// refuses to load. The corpus that declares this driver is the corpus that
// installed it.
//
// Every selector and every expected string was written into the scenario once,
// at practice time. Nothing here asks a model what to click.
export const id = "playwright";

let mod = null;
export async function available() {
  if (mod) return { ok: true };
  try { mod = await import("playwright"); return { ok: true }; }
  catch (e) { return { ok: false, why: `playwright is not installed on this box (${String(e.message || e).split("\n")[0]})` }; }
}

export async function open({ base = "" } = {}, target) {
  const a = await available();
  if (!a.ok) throw new Error(a.why);
  const browser = await mod.chromium.launch();
  const page = await browser.newPage();
  const s = { browser, page, base };
  if (target) await page.goto(url(s, target), { waitUntil: "domcontentloaded" });
  return s;
}

const url = (s, t) => (/^(https?|file):/i.test(t) ? t : `${String(s.base).replace(/\/$/, "")}${t.startsWith("/") ? t : `/${t}`}`);

export async function act(s, a) {
  try {
    if (a.verb === "open") { await s.page.goto(url(s, a.target), { waitUntil: "domcontentloaded" }); return { ok: true, got: { url: s.page.url() } }; }
    if (a.verb === "click") { await s.page.click(a.selector, { timeout: 5000 }); return { ok: true, got: { clicked: a.selector } }; }
    if (a.verb === "type") { await s.page.fill(a.selector, a.text, { timeout: 5000 }); return { ok: true, got: { typed: a.selector } }; }
    if (a.what === "text") {
      const body = await s.page.textContent("body", { timeout: 5000 });
      return String(body || "").includes(a.text) ? { ok: true, got: {} }
        : { ok: false, why: `the page does not contain ${JSON.stringify(a.text)}`, got: { page_text: String(body || "").slice(0, 240) } };
    }
    const n = await s.page.locator(a.selector).count();
    const vis = n ? await s.page.locator(a.selector).first().isVisible() : false;
    if (a.what === "visible") return vis ? { ok: true, got: { matched: n } } : { ok: false, why: n ? `\`${a.selector}\` is in the page but not visible` : `nothing matches \`${a.selector}\`` };
    return vis ? { ok: false, why: `\`${a.selector}\` is visible, expected absent` } : { ok: true, got: {} };
  } catch (e) { return { ok: false, why: String(e.message || e).split("\n")[0] }; }
}

export async function close(s) { try { await s?.browser?.close(); } catch { /* already gone */ } }
