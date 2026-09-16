// mainboard/bugbash.js — the bar a screen has to clear, checked against the
// screen and not against the source.
//
// Ported from spinwish's `mainboard/bugbash/`, which ran six mechanizable rows
// through Playwright and left fourteen more to a person reading screenshots.
// The six are here. The fourteen are not, and pretending otherwise would be the
// failure this board exists to prevent: green because nothing was checked.
//
// The seam with `designlabs` is the reason this is a separate view rather than
// another designlabs rule. designlabs measures the DECLARATION — `state.coverage`
// reads the screens' `states` blocks, `target.min-size` reads their declared
// targets — and it says so itself, in the rule it cannot close:
//
//     affordance.signified   unknown   a parse cannot see a pixel
//
// bugbash is the pixel. Every finding here is a measurement taken against a
// rendered page, so the pair produces the one comparison neither can make
// alone: the declaration passed and the screen does something else. A finding
// in that shape carries `refers: "designlabs"`, because the declaration is
// where it gets settled.
//
// This module holds only the judgement. `dotty.sweep` owns the browser.
import { slug } from "../core/util.js";

/** Copy that contradicts something the product is committed to. Empty by
 *  default and per-workspace on purpose: spinwish banned "refund" because
 *  payments there are final, which is a fact about spinwish and not about
 *  software. A default list would file a finding against a word somebody meant. */
export const BANNED_DEFAULT = [];

const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

/** A request every browser makes, no page asks for, and no dev server serves.
 *  Filing it is how a board teaches a reader to skim past real rows. */
const IGNORED_RESOURCE = /\/favicon\.ico(\?|$)|\/apple-touch-icon[^/]*\.png(\?|$)/i;

/** One rendered screen, judged. `wide` and `narrow` are the same measurement at
 *  two viewports; a row that only matters on a phone is only filed from the
 *  narrow pass. */
export function judge(row, { banned = BANNED_DEFAULT, declared = null, narrowWidth = 390 } = {}) {
  const findings = [];
  const route = row.label || row.url || "screen";
  const shot = row.file || null;
  const at = { route, url: row.url || "", screenshot: shot };
  const wide = row.wide || {};
  const narrow = row.narrow || null;

  // R1 of the port: every finding cites the capture. A page that produced no
  // screenshot produced no evidence, and the rows below would be opinions.
  if (!shot) return { findings, facts: { route, judged: false, why: "the capture wrote no screenshot" } };

  // The route's own answer, before anything about how it looks. A 404 renders
  // the server's error page, which measures as a page: it has text, it is not
  // blank, and every row below would be a finding about a screen that is not
  // the product.
  if (row.status !== null && row.status !== undefined && (row.status < 200 || row.status >= 300)) {
    findings.push({ id: `BB-${route}-status`, category: "STATE", severity: "high",
      title: `${route} answered ${row.status}`,
      detail: `The URL under this route returned ${row.status}, so what was captured is whatever the server renders for that — not the screen. Either the route is wrong or it is gone; nothing below it was measured.`,
      evidence: { ...at, status: row.status, mime: row.mime || "" }, target: "local" });
    return { findings, facts: { route, judged: true, status: row.status } };
  }

  if (row.blank === true) {
    findings.push({ id: `BB-${route}-blank`, category: "STATE", severity: "high",
      title: `${route} rendered nothing`,
      detail: `The page loaded and the frame is a picture of nothing: ${row.blank_why || "no variation in the image"}. A blank screen and a screen whose data never arrived are the same picture, so this is filed before anything else on this route is worth reading.`,
      evidence: { ...at, why: row.blank_why || "", text_length: wide.textLen ?? null, nodes: row.nodes ?? null }, target: "local" });
    // Everything after this would be measuring an empty page.
    return { findings, facts: { route, judged: true, blank: true } };
  }

  // Horizontal overflow. Two rows, because they are two different mistakes:
  // a desktop layout that overflows is broken for everybody, and one that only
  // overflows at 390 is the one that ships.
  if (wide.overflow > 1) {
    findings.push({ id: `BB-${route}-overflow-wide`, category: "UI", severity: "medium",
      title: `${route} scrolls sideways at ${wide.innerW}px`,
      detail: `The document is ${wide.overflow}px wider than the viewport, so the page has a horizontal scrollbar at desktop width. Something inside it is not respecting the container.`,
      evidence: { ...at, viewport: wide.innerW, document: wide.scrollW, overflow_px: wide.overflow }, target: "local" });
  }
  // A page with no viewport meta is laid out by a phone at ~980 CSS px and then
  // zoomed out, so the 390px pass below measured a 980px layout and its "fits"
  // is not the answer it looks like. Filing the absence is the honest move: it
  // is the defect AND the reason the next row cannot be trusted.
  if (narrow && wide.viewportMeta === false) {
    findings.push({ id: `BB-${route}-viewport-meta`, category: "UI", severity: "medium",
      title: `${route} declares no viewport meta`,
      detail: `Without \`<meta name="viewport">\` a phone lays the page out at about 980px and scales it down, so text is unreadable and the ${narrowWidth}px measurement here is of a 980px layout rather than of a phone.`,
      evidence: { ...at, viewport_meta: false, measured_at: narrowWidth, narrow_overflow: narrow.overflow }, target: "local" });
  }
  if (narrow && narrow.overflow > 1) {
    findings.push({ id: `BB-${route}-overflow-narrow`, category: "UI", severity: "high",
      title: `${route} scrolls sideways at ${narrowWidth}px`,
      detail: `The document is ${narrow.overflow}px wider than a ${narrowWidth}px viewport.${wide.overflow > 1 ? "" : " It fits at desktop width, so this is a phone-only break and nobody testing on a laptop will see it."}`,
      evidence: { ...at, viewport: narrowWidth, document: narrow.scrollW, overflow_px: narrow.overflow }, target: "local" });
  }

  if (wide.noAltCount > 0) {
    findings.push({ id: `BB-${route}-alt`, category: "A11Y", severity: "medium",
      title: `${route}: ${wide.noAltCount} of ${wide.images} image(s) have no alt attribute`,
      detail: `A screen reader announces these as the filename or as nothing. An image that carries no meaning still needs \`alt=""\` to say so — the absent attribute and the empty one mean different things and only one of them is a decision.`,
      evidence: { ...at, images: wide.images, without_alt: wide.noAltCount, sample: wide.noAlt.slice(0, 6) }, target: "local" });
  }

  // 44×44 is a touch rule, so it is measured at the touch viewport and only
  // filed from there. Filing it against a mouse pointer at 1280 would be a
  // finding about the wrong input device.
  const tap = narrow || null;
  if (tap && tap.smallCount > 0) {
    const declaredPass = declared && declared["target.min-size"] === "pass";
    findings.push({ id: `BB-${route}-tap`, category: "A11Y", severity: declaredPass ? "high" : "medium",
      title: `${route}: ${tap.smallCount} of ${tap.interactive} tap target(s) are under 44×44 at ${narrowWidth}px`,
      detail: declaredPass
        ? `designlabs reports \`target.min-size\` as a pass over the declared screens, and the rendered page has ${tap.smallCount} target(s) below the floor. The declaration and the screen disagree; the declaration is where that is settled.`
        : `Below the 44×44 touch floor. Measured from the rendered box, so a target that is large in the design and small on screen is caught here and nowhere else.`,
      evidence: { ...at, viewport: narrowWidth, interactive: tap.interactive, under_floor: tap.smallCount, sample: tap.small.slice(0, 8), declared: declaredPass ? "designlabs: target.min-size pass" : null },
      refers: declaredPass ? "designlabs" : "", target: "local" });
  }

  if (wide.unlabelledCount > 0) {
    findings.push({ id: `BB-${route}-unlabelled`, category: "A11Y", severity: "high",
      title: `${route}: ${wide.unlabelledCount} of ${wide.interactive} interactive element(s) have no accessible name`,
      detail: `Each has no text, no \`aria-label\`, no \`title\`, no \`aria-labelledby\` and no icon inside it. A screen reader reaches it and has nothing to announce; a person reaches it and cannot tell what it does. This is the dead-control row: ${pct(wide.unlabelledCount, wide.interactive)}% of what is clickable on this screen.`,
      evidence: { ...at, interactive: wide.interactive, unnamed: wide.unlabelledCount, sample: wide.unlabelled.slice(0, 8) }, target: "local" });
  }

  const hits = [];
  for (const phrase of banned) {
    const rx = new RegExp(String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const m = rx.exec(wide.text || "");
    if (m) hits.push({ phrase: String(phrase), context: (wide.text || "").slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, " ") });
  }
  if (hits.length) {
    findings.push({ id: `BB-${route}-copy`, category: "COPY", severity: "high",
      title: `${route} shows copy this workspace bans: ${hits.map((h) => `"${h.phrase}"`).join(", ")}`,
      detail: `The phrase is on screen. A banned phrase is banned because it contradicts something the product is committed to, so this is a blocker rather than a nitpick — the screen is promising something the system does not do.`,
      evidence: { ...at, hits: hits.slice(0, 6) }, target: "local" });
  }

  // The port's row 6 is "no uncaught console errors", and the browser reports
  // three different things down one channel. The first capture this ran filed
  // "the page threw 1 error" against a missing favicon, which is the shape of
  // noise that gets a board ignored: a 404 for an icon is not code that failed
  // to run. So they are separated, and the icon is dropped entirely — it is
  // always a 404 on a dev server and never a defect in the product.
  const all = row.errors || [];
  const thrown = all.filter((e) => e.kind === "exception" || e.kind === "console");
  const subresource = all.filter((e) => e.kind !== "exception" && e.kind !== "console" && !IGNORED_RESOURCE.test(e.url || ""));

  if (thrown.length) {
    findings.push({ id: `BB-${route}-console`, category: "UI", severity: "high",
      title: `${route} threw ${thrown.length} error(s) while loading`,
      detail: `The screen rendered and the page threw. ${thrown[0].text || ""} — an error during load is a piece of the screen that did not run, and the part it would have rendered is missing from every other row measured here.`,
      evidence: { ...at, errors: thrown.slice(0, 8), count: thrown.length }, target: "local" });
  }
  if (subresource.length) {
    findings.push({ id: `BB-${route}-subresource`, category: "UI", severity: "medium",
      title: `${route} asked for ${subresource.length} file(s) the server did not give it`,
      detail: `The page requested these and did not get them: ${subresource.slice(0, 4).map((e) => e.url || e.text).join(", ")}. The screen still rendered, so this is filed below a thrown error — but a stylesheet or a script that 404s means the screenshot above is of a page missing part of itself.`,
      evidence: { ...at, requests: subresource.slice(0, 8), count: subresource.length }, target: "local" });
  }

  return { findings, facts: { route, judged: true, blank: false, interactive: wide.interactive ?? 0,
    images: wide.images ?? 0, errors: (row.errors || []).length,
    overflow_wide: wide.overflow ?? null, overflow_narrow: narrow ? narrow.overflow : null } };
}

/** Where the routes come from. Never guessed: a view that invents a URL probes
 *  something nobody asked about and reports on a page that is not the product. */
export function routesFrom(cfg = {}, base = "") {
  const declared = Array.isArray(cfg.routes) ? cfg.routes : [];
  const out = [];
  for (const r of declared) {
    const row = typeof r === "string" ? { path: r } : r || {};
    const p = String(row.path || row.url || "");
    if (!p) continue;
    const url = /^https?:\/\//i.test(p) ? p : base ? base.replace(/\/$/, "") + (p.startsWith("/") ? p : `/${p}`) : "";
    if (!url) continue;
    // The label becomes the finding id, so it has to survive being one: a
    // finding keyed `BB-http://host/x-blank` cannot be matched on the next run
    // and files a second copy every time.
    const fallback = (() => { try { return new URL(url).pathname.replace(/^\/|\/$/g, "") || "root"; } catch { return "root"; } })();
    out.push({ label: slug(String(row.label || row.id || fallback)), url });
  }
  return out;
}
