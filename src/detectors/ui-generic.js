// ui-generic — the tells of an interface assembled from the current tooling's
// defaults. Every tell is a count, a parse or a set difference over the source,
// so the whole detector costs milliseconds and no tokens; none of it is a
// judgement about taste. A tell is a decision that was never made: the default
// accent, the default family, one radius, one shadow, only :hover. The doctrine
// and the remedies live in designlabs/principles/anti-generic.md.
import { corpus, finding, isGeneratedText, lineIndex, snippet } from "./_shared.js";

const UI_SUFFIX = /\.(css|scss|sass|less|html|htm|vue|svelte|jsx|tsx|dart)$/i;

// The named ramps of the two frameworks that ship the look. Verbatim presence is
// the evidence: a hand-picked palette does not land on #6366f1 by accident.
const FRAMEWORK_HEX = new Set([
  "#6366f1", "#4f46e5", "#4338ca", "#818cf8", "#a5b4fc", "#eef2ff",
  "#8b5cf6", "#7c3aed", "#a78bfa", "#6d28d9", "#a855f7", "#9333ea", "#c084fc",
  "#3b82f6", "#2563eb", "#1d4ed8", "#60a5fa", "#93c5fd", "#dbeafe",
  "#0ea5e9", "#0284c7", "#38bdf8", "#06b6d4", "#0891b2",
  "#64748b", "#94a3b8", "#475569", "#334155", "#1e293b", "#0f172a", "#cbd5e1",
  "#e2e8f0", "#f1f5f9", "#f8fafc", "#6b7280", "#9ca3af", "#4b5563", "#374151",
  "#1f2937", "#111827", "#d1d5db", "#e5e7eb", "#f3f4f6", "#f9fafb",
  "#10b981", "#059669", "#34d399", "#ef4444", "#dc2626", "#f87171",
  "#f59e0b", "#d97706", "#fbbf24", "#14b8a6", "#f43f5e", "#ec4899",
]);

// Families that are the absence of a typographic decision rather than one.
const DEFAULT_FAMILY = /^(inter|system-ui|ui-sans-serif|-apple-system|blinkmacsystemfont|apple-system|segoe ui|roboto|helvetica( neue)?|arial|sans-serif|serif|monospace|ui-monospace|noto sans|oxygen|ubuntu|cantarell|"?sf pro[^",]*"?)$/i;

const COPY_TELLS = [
  /\belevate your\b/i, /\bseamlessly\b/i, /\bunlock the (full )?power\b/i,
  /\btake your [\w\s]{1,24} to the next level\b/i, /\bsupercharge your\b/i,
  /\bharness the power\b/i, /\bempower(ing)? (your|teams?|developers?)\b/i,
  /\bcutting[- ]edge\b/i, /\brevolutioniz(e|ing)\b/i, /\blorem ipsum\b/i,
  /\bgame[- ]chang(er|ing)\b/i, /\bblazing[- ]fast\b/i, /\bnext[- ]generation\b/i,
];

// Emoji used where an icon belongs. Pictographs only: ™ ® and arrows are not tells.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F0FF}]/u;

const PX = /(-?\d+(?:\.\d+)?)px/;

function scanFile(r, t, acc) {
  const line = lineIndex(t);
  const at = (i) => line(i);
  const hit = (tell, i, text) => acc[tell].push({ file: r, line: at(i), text: snippet(text, 100) });

  for (const m of t.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const hex = m[0].toLowerCase();
    (FRAMEWORK_HEX.has(hex) ? acc.hexFramework : acc.hexOwn).add(hex);
    if (FRAMEWORK_HEX.has(hex) && acc.palette.length < 12) hit("palette", m.index, m[0] + "  " + t.slice(Math.max(0, m.index - 40), m.index + 20).split("\n").pop());
  }
  for (const m of t.matchAll(/\b(?:bg|text|border|from|via|to|ring|shadow|fill)-(indigo|violet|purple|blue|sky|slate|gray|grey|cyan|teal|emerald|rose|fuchsia)-(\d00)\b/g)) {
    acc.hexFramework.add(`${m[1]}-${m[2]}`);
    if (acc.palette.length < 12) hit("palette", m.index, m[0]);
  }

  // Custom properties first: a design system declares its families as tokens and
  // uses them as `font-family: var(--font-text)`. Reading only the literal
  // declarations found nothing there and called a chosen typeface unchosen —
  // punishing exactly the practice worth having.
  const vars = new Map();
  for (const m of t.matchAll(/(--[\w-]+)\s*:\s*([^;}\n]+)/g)) vars.set(m[1], m[2].trim());
  const deref = (v, depth = 0) => {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)$/.exec(String(v).trim());
    if (!m || depth > 4) return v;
    return deref(vars.get(m[1]) ?? m[2] ?? "", depth + 1);
  };
  const family = (raw) => {
    for (const fam of String(raw).split(",")) {
      const name = fam.trim().replace(/['"]/g, "").trim();
      if (!name || name.startsWith("var(")) continue;
      (DEFAULT_FAMILY.test(name) ? acc.famDefault : acc.famOwn).add(name.toLowerCase());
    }
  };
  for (const m of t.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)) family(deref(m[1]));
  // A `--font-*` token IS the declaration, whether or not this file also uses it.
  for (const [k, v] of vars) if (/font/i.test(k) && /[a-z]/i.test(v) && !/^\d/.test(v)) family(deref(v));
  for (const m of t.matchAll(/\bfontFamily\s*:\s*['"]([^'"]+)/g)) {
    const name = m[1].split(",")[0].trim();
    (DEFAULT_FAMILY.test(name) ? acc.famDefault : acc.famOwn).add(name.toLowerCase());
  }

  for (const m of t.matchAll(/border-radius\s*:\s*([^;}\n]+)/gi)) {
    const v = m[1].trim();
    if (!/var\(/.test(v)) acc.radius.set(v, (acc.radius.get(v) || 0) + 1);
  }
  for (const m of t.matchAll(/\brounded-(sm|md|lg|xl|2xl|3xl|full|none)\b/g)) acc.radius.set(m[1], (acc.radius.get(m[1]) || 0) + 1);

  for (const m of t.matchAll(/linear-gradient\(([^)]{0,160})\)/gi)) {
    const body = m[1].toLowerCase();
    const stops = [...body.matchAll(/#[0-9a-f]{6}/g)].map((x) => x[0]);
    if (stops.length >= 2 && stops.every((s) => FRAMEWORK_HEX.has(s))) hit("gradient", m.index, m[0]);
  }
  for (const m of t.matchAll(/\bbg-gradient-to-[a-z]{1,2}\b/g)) hit("gradient", m.index, m[0]);

  for (const m of t.matchAll(/box-shadow\s*:\s*([^;}\n]+)/gi)) {
    const v = m[1].trim().toLowerCase();
    if (v === "none" || /var\(/.test(v)) continue;
    acc.shadow.set(v, (acc.shadow.get(v) || 0) + 1);
    if (!acc.shadowAt.has(v)) acc.shadowAt.set(v, { file: r, line: at(m.index) });
  }
  for (const m of t.matchAll(/\bshadow-(sm|md|lg|xl|2xl)\b/g)) {
    acc.shadow.set(m[1], (acc.shadow.get(m[1]) || 0) + 1);
    if (!acc.shadowAt.has(m[1])) acc.shadowAt.set(m[1], { file: r, line: at(m.index) });
  }

  // Emoji inside markup text or as a JSX/Dart string that sits beside an icon slot.
  for (const m of t.matchAll(/>([^<>{}\n]{0,60})</g)) {
    if (EMOJI.test(m[1]) && acc.emoji.length < 12) hit("emoji", m.index, m[1]);
  }
  for (const m of t.matchAll(/(?:icon|emoji|glyph|symbol)\s*[:=]\s*['"]([^'"]{1,8})['"]/gi)) {
    if (EMOJI.test(m[1]) && acc.emoji.length < 12) hit("emoji", m.index, m[0]);
  }

  for (const re of COPY_TELLS) {
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      if (acc.copy.length < 12) hit("copy", m.index, t.slice(m.index, m.index + 80).split("\n")[0]);
    }
  }

  if (/\b(hero|Hero)\b/.test(t)) acc.hero = true;
  for (const m of t.matchAll(/grid-template-columns\s*:\s*repeat\(\s*3\s*,|grid-cols-3\b/g)) {
    if (acc.grid3.length < 8) hit("grid3", m.index, m[0]);
  }

  acc.hover += (t.match(/:hover\b/g) || []).length;
  acc.focusVisible += (t.match(/:focus-visible\b|focus-visible:/g) || []).length;
  acc.disabled += (t.match(/:disabled\b|\[disabled\]|aria-disabled|disabled:/g) || []).length;
  acc.stateWords += (t.match(/\b(empty[-_ ]?state|error[-_ ]?state|loading[-_ ]?state|skeleton|offline|degraded)\b/gi) || []).length;

  for (const m of t.matchAll(/(?:gap|row-gap|column-gap|padding|margin)(?:-(?:top|right|bottom|left|inline|block))?\s*:\s*([^;}\n]+)/gi)) {
    for (const part of m[1].trim().split(/\s+/)) {
      const px = PX.exec(part);
      if (!px) continue;
      const n = Math.abs(Number(px[1]));
      if (n > 0 && n <= 200) acc.space.set(n, (acc.space.get(n) || 0) + 1);
    }
  }
}

function tell(area, id, title, detail, evidence, files, fix) {
  return finding({
    detector: "ui-generic", severity: "medium", kind: "fix",
    key: `ui-generic:${area}:${id}`, path: files[0] || area, files: files.slice(0, 6),
    title: `${area}: ${title}`, detail, evidence: { tell: id, area, ...evidence },
    fix_hint: fix,
  });
}

const blank = () => ({
  hexFramework: new Set(), hexOwn: new Set(), famDefault: new Set(), famOwn: new Set(),
  radius: new Map(), shadow: new Map(), shadowAt: new Map(), space: new Map(),
  palette: [], gradient: [], emoji: [], copy: [], grid3: [],
  hover: 0, focusVisible: 0, disabled: 0, stateWords: 0, hero: false, files: [],
});

// Per top-level directory, never per tree. One corrected stylesheet in
// designlabs/ must not mask an uncorrected one in web/: aggregated over a whole
// repo these counts cancel, and the answer to "which part of this is generic"
// is the only useful form of the question anyway.
const areaOf = (r) => (r.includes("/") ? r.split("/")[0] : ".");

function analyse(area, acc, min, cfg) {
    if (acc.files.length === 0) return [];
    const out = [];
    const filesOf = (rows) => [...new Set(rows.map((h) => h.file))];
    const lines = (rows) => rows.slice(0, 6).map((h) => `  ${h.file}:${h.line}  ${h.text}`).join("\n");

    if (acc.hexFramework.size >= min.palette && acc.hexFramework.size >= acc.hexOwn.size) {
      out.push(tell(area, "default-palette",
        `the palette is the framework's — ${acc.hexFramework.size} default ramp values against ${acc.hexOwn.size} of your own`,
        `Default values in use:\n  ${[...acc.hexFramework].slice(0, 16).join("  ")}\n\nFirst sites:\n${lines(acc.palette)}`,
        { framework: [...acc.hexFramework].slice(0, 24), own: [...acc.hexOwn].slice(0, 24), counts: { framework: acc.hexFramework.size, own: acc.hexOwn.size } },
        filesOf(acc.palette),
        "Commit to one hue and derive the ramp from it. Keep the accent scarce — see designlabs/principles/von-restorff.md."));
    }

    if (acc.famOwn.size === 0 && acc.famDefault.size > 0) {
      out.push(tell(area, "no-typeface",
        `no typeface was chosen — only ${[...acc.famDefault].slice(0, 4).join(", ")}`,
        `Families declared in ${area}:\n  ${[...acc.famDefault].join(", ")}\n\nTypeface is the highest-leverage move away from a generic look, and it is unmade here.`,
        { default: [...acc.famDefault], own: [] }, acc.files.filter((f) => /\.(css|scss|less)$/.test(f)).slice(0, 4),
        "One characterful display face, one plain text face. `bb designlabs sources --kind type` lists Typewolf and Fontsource; the latter has a real API, so a candidate can be checked for a shippable licence."));
    }

    const radiusValues = [...acc.radius.keys()];
    const radiusUses = [...acc.radius.values()].reduce((a, b) => a + b, 0);
    if (radiusValues.length > 0 && radiusValues.length <= 2 && radiusUses >= min.radius) {
      out.push(tell(area, "uniform-radius",
        `one radius for everything — ${radiusValues.join(", ")} across ${radiusUses} uses`,
        "Radius is a hierarchy signal and here it carries none. Dense controls and large surfaces should not round the same.",
        { values: Object.fromEntries(acc.radius), uses: radiusUses }, acc.files.slice(0, 4),
        "Give radius a scale: small on inputs and chips, larger on cards and sheets, and never the same number on both."));
    }

    if (acc.gradient.length > 0) {
      out.push(tell(area, "framework-gradient",
        `${acc.gradient.length} gradient${acc.gradient.length === 1 ? "" : "s"} built from the default ramp`,
        lines(acc.gradient), { count: acc.gradient.length, hits: acc.gradient.slice(0, 8) }, filesOf(acc.gradient),
        "The indigo-to-violet diagonal is the most recognisable machine-made mark on the web. Use one flat colour you chose, or a gradient between two values you chose."));
    }

    const topShadow = [...acc.shadow.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topShadow && topShadow[1] >= min.shadow && acc.shadow.size <= 2) {
      const site = acc.shadowAt.get(topShadow[0]);
      out.push(tell(area, "shadow-monotony",
        `one shadow on every surface — \`${snippet(topShadow[0], 48)}\` used ${topShadow[1]} times`,
        `Elevation is spatial information. A single repeated shadow is decoration wearing its clothes.\n  ${site.file}:${site.line}`,
        { values: Object.fromEntries(acc.shadow), top: topShadow[0], uses: topShadow[1] }, [site.file],
        "Two or three elevations at most, each meaning a distance: resting, raised, floating. On a light theme a border and a background shift carry elevation more honestly than blur."));
    }

    if (acc.emoji.length > 0) {
      out.push(tell(area, "emoji-icons",
        `${acc.emoji.length} emoji standing in for icons`,
        lines(acc.emoji), { count: acc.emoji.length, hits: acc.emoji.slice(0, 8) }, filesOf(acc.emoji),
        "Emoji render differently on every platform, carry no weight or optical size, and vanish in greyscale. Draw or license an icon set."));
    }

    if (acc.copy.length > 0) {
      out.push(tell(area, "template-copy",
        `${acc.copy.length} phrase${acc.copy.length === 1 ? "" : "s"} written to fill a slot`,
        lines(acc.copy), { count: acc.copy.length, hits: acc.copy.slice(0, 8) }, filesOf(acc.copy),
        "Say what the thing does, for whom, in the words that user would use. Every phrase flagged here is true of any product, which is another way of saying it is about none."));
    }

    if (acc.hero && acc.grid3.length > 0) {
      out.push(tell(area, "hero-three-cards",
        "the template layout — a centred hero over a three-column feature grid",
        lines(acc.grid3), { hero: true, grids: acc.grid3.length }, filesOf(acc.grid3),
        "Three is the count a generator reaches for. Let the number of cards be the number of true things, and break the grid where the content is not peers."));
    }

    if (acc.hover >= 4 && acc.focusVisible === 0) {
      out.push(tell(area, "happy-path-only",
        `:hover styled ${acc.hover} times, :focus-visible never`,
        `hover ${acc.hover} · focus-visible ${acc.focusVisible} · disabled ${acc.disabled} · empty/error/loading words ${acc.stateWords}\n\nA keyboard user cannot see where they are. This fails WCAG 2.2 SC 2.4.11 as well as reading as unfinished.`,
        { hover: acc.hover, focus_visible: acc.focusVisible, disabled: acc.disabled, state_words: acc.stateWords },
        acc.files.filter((f) => /\.(css|scss|less)$/.test(f)).slice(0, 4),
        "Style :focus-visible everywhere :hover is styled, then draw :disabled, empty, error and loading. See designlabs/principles/visibility-of-status.md."));
    }

    const spaceUses = [...acc.space.values()].reduce((a, b) => a + b, 0);
    const spaceValues = [...acc.space.keys()].sort((a, b) => a - b);
    if (spaceUses >= min.space && spaceValues.length <= 3 && spaceValues.every((n) => n % 8 === 0)) {
      out.push(tell(area, "spacing-monotony",
        `the spacing scale is ${spaceValues.join("/")}px across ${spaceUses} uses`,
        `Every gap is a multiple of eight and there are ${spaceValues.length} of them, so nothing on the page is near anything and nothing is far.`,
        { values: Object.fromEntries(acc.space), uses: spaceUses }, acc.files.filter((f) => /\.(css|scss|less)$/.test(f)).slice(0, 4),
        "Make the scale non-linear — 4, 8, 12, 20, 32, 52. Grouping is carried by the RATIO between an inner gap and an outer one; see designlabs/principles/gestalt-grouping.md."));
    }

    // The count is the headline for this area. Emitted last so it is the row a
    // reader ends on, and keyed per area so two trees do not share one verdict.
    if (out.length) {
      out.push(finding({
        detector: "ui-generic", severity: out.length >= 5 ? "high" : "medium", kind: "investigate",
        auto_fix: "plan-ui-leverage",
        key: `ui-generic:${area}:count`, path: acc.files[0] || area, files: acc.files.slice(0, 6),
        title: `${area}: ${out.length} generic tells across ${acc.files.length} interface file${acc.files.length === 1 ? "" : "s"}`,
        detail: out.map((f) => `  ${String(f.evidence.tell).padEnd(20)} ${f.title}`).join("\n"),
        evidence: { tell: "count", area, tells: out.map((f) => f.evidence.tell), ui_files: acc.files.length, threshold: cfg.generic_max ?? 2 },
        fix_hint: "Work the list in order of leverage: typeface, then palette, then spacing rhythm, then state coverage. `bb designlabs principles anti-generic` holds the reasoning.",
      }));
    }

    return out;
}

export default {
  name: "ui-generic", precision: "heuristic", severity: "medium",
  description: "the countable tells of an interface built from framework defaults: default palette, one family, one radius, one shadow, emoji icons, template copy, no focus or disabled states",
  run(ctx) {
    const cfg = (ctx.cfg && ctx.cfg.designlabs) || {};
    const min = { palette: 6, radius: 5, shadow: 5, space: 20, ...(cfg.generic_min || {}) };
    const areas = new Map();
    for (const [r, t] of corpus(ctx)) {
      if (!UI_SUFFIX.test(r) || isGeneratedText(r, t)) continue;
      const a = areaOf(r);
      if (!areas.has(a)) areas.set(a, blank());
      const acc = areas.get(a);
      acc.files.push(r);
      scanFile(r, t, acc);
    }
    const out = [];
    for (const [area, acc] of [...areas].sort()) out.push(...analyse(area, acc, min, cfg));
    return out;
  },
};
