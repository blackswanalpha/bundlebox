// commandcenter/brand.js — the mark, at the two sizes a page needs it.
//
// The full mark in `assets/logo.svg` is built for a 512px tile: a woven field,
// four gradients, a rim light. None of that survives being drawn at 24px in a
// header or 16px in a tab strip — the gradients collapse to one muddy value and
// the weave becomes noise. So this file holds a REDRAWN version at the weight
// those sizes need, rather than a scaled one.
//
// What is kept is the identity: the isometric cube, the three interior edges
// converging on the centre, and the closed ring that is the zero. What is
// dropped is everything that only reads above about 64px. Both sizes take their
// colour from `currentColor` so the mark is correct in either theme without a
// second copy.
//
// The favicon is a data URI rather than a file because the command centre has
// two delivery modes — a server and a single self-contained HTML file — and a
// `<link href="/favicon.svg">` is a blank tab in the second one.

/** The header mark. `currentColor` for the silhouette, the accent for the ring,
 *  so it sits in the type rather than beside it. */
export const mark = (size = 22) => `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <path d="M24 3.5 L42.5 14.2 L42.5 33.8 L24 44.5 L5.5 33.8 L5.5 14.2 Z" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round" opacity=".9"/>
  <path d="M5.5 14.2 L24 24.9 L42.5 14.2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" opacity=".28"/>
  <path d="M24 24.9 L24 44.5" stroke="currentColor" stroke-width="1.8" opacity=".28"/>
  <circle cx="24" cy="23.4" r="7.4" fill="var(--bg)"/>
  <circle cx="24" cy="23.4" r="7.4" stroke="var(--accent)" stroke-width="4"/>
</svg>`;

/** The tab icon. Standalone — no CSS variables, because a favicon is rendered
 *  outside the document and inherits nothing from it. Two flat colours and a
 *  filled ground so it is legible on a light tab strip and a dark one. */
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="11" fill="#07271D"/>
  <path d="M24 7 L40 16.2 L40 32.8 L24 42 L8 32.8 L8 16.2 Z" fill="none" stroke="#6FEFC0" stroke-width="3" stroke-linejoin="round"/>
  <path d="M8 16.2 L24 25.4 L40 16.2" fill="none" stroke="#6FEFC0" stroke-width="2.2" stroke-linejoin="round" opacity=".5"/>
  <path d="M24 25.4 L24 42" stroke="#6FEFC0" stroke-width="2.2" opacity=".5"/>
  <circle cx="24" cy="23.4" r="6" fill="#07271D"/>
  <circle cx="24" cy="23.4" r="6" fill="none" stroke="#CFFFEC" stroke-width="3.4"/>
</svg>`;

/** A data URI, minified and percent-encoded. Not base64: an SVG data URI stays
 *  readable and diffable this way, and the encoded form is shorter. */
export const faviconHref = () => "data:image/svg+xml," + encodeURIComponent(
  FAVICON.replace(/\n\s*/g, " ").trim()).replace(/'/g, "%27").replace(/"/g, "%22");
