// designlabs/declared.js — the studio's source of truth: one system and one
// screen, as JSON.
//
// Deliberately not the framework default. A scaffold that shipped Inter and
// indigo would fail its own `ui-generic` detector on the first scan, which is
// the joke this toolkit exists to stop telling. Everything in assets.js is
// DERIVED from these two objects (doctrine 7), so the stylesheet and the
// browser studio cannot drift from what the gate reads.

export const SYSTEM = {
  name: "studio",
  note: "A starting hand, not a decision. Replace the hue and both typefaces with ones you chose on purpose; the gate will keep holding the floors either way.",
  type: {
    display: { family: "Fraunces", fallback: "Georgia, serif", license: "OFL", weights: [400, 600], source: "fontsource:fraunces" },
    text: { family: "Public Sans", fallback: "Helvetica, Arial, sans-serif", license: "OFL", weights: [400, 500, 700], source: "fontsource:public-sans" },
    scale: { micro: "12px", small: "14px", body: "16px", lead: "19px", title: "25px", display: "38px" },
  },
  color: {
    tokens: {
      paper: "#FAF8F3", surface: "#F1EEE5", ink: "#14170F", muted: "#5A5F52",
      border: "#74786B", rule: "#DCD7C9", accent: "#2F5D50", danger: "#8C2F1D",
      night: "#12140F", "night-surface": "#1B1E18", "night-ink": "#EDEBE3",
      "night-muted": "#9AA091", "night-border": "#787C6E", "night-accent": "#7FBFA6",
    },
    pairs: [
      { fg: "ink", bg: "paper", use: "body text", size: "text" },
      { fg: "muted", bg: "paper", use: "secondary text", size: "text" },
      { fg: "accent", bg: "paper", use: "link and focus ring", size: "ui" },
      { fg: "paper", bg: "accent", use: "primary button label", size: "text" },
      { fg: "border", bg: "paper", use: "control boundary", size: "ui" },
      { fg: "danger", bg: "paper", use: "error text", size: "text" },
      { fg: "night-ink", bg: "night", use: "body text, dark", size: "text" },
      { fg: "night-muted", bg: "night", use: "secondary text, dark", size: "text" },
      { fg: "night-accent", bg: "night", use: "link and focus ring, dark", size: "ui" },
      { fg: "night-border", bg: "night", use: "control boundary, dark", size: "ui" },
    ],
  },
  // Non-linear on purpose: grouping is carried by the RATIO between an inner
  // gap and an outer one, and a pure 8-multiple scale has no ratios to use.
  space: [4, 8, 12, 20, 32, 52, 84],
  radius: { control: "6px", surface: "18px", pill: "999px" },
  motion: { instant: "90ms", state: "160ms", enter: "240ms", sheet: "320ms" },
  easing: { standard: "cubic-bezier(0.2, 0, 0, 1)", exit: "cubic-bezier(0.4, 0, 1, 1)" },
  targets: { row: "56px", "icon-button": "44px", chip: "44px", "list-item": "48px" },
  elevation: { resting: "none", raised: "0 1px 2px rgba(20,23,15,0.10), 0 0 0 1px rgba(20,23,15,0.05)", floating: "0 12px 32px rgba(20,23,15,0.18)" },
};

export const SCREEN = {
  id: "worklist",
  area: "home",
  title: "Worklist",
  lede: "Everything that needs a decision today, ranked, with the reason it is here.",
  primary: "resolve",
  secondary: ["filter", "snooze", "open-source"],
  disclosure_depth: 1,
  accents: 1,
  states: {
    rest: { label: "Rest", note: "Five rows, ranked. The top row is the only accented element." },
    loading: { label: "Loading", skeleton: true, note: "Five row-shaped skeletons, so the page does not resize when data lands." },
    empty: { label: "Empty", variant: "first-run", note: "Nothing to decide before 2pm. Says what will bring rows here, not just that there are none." },
    error: { label: "Error", copy: "Couldn't reach the calendar. Retry, or work from what was cached at 06:12." },
    partial: { label: "Partial", note: "Mail arrived, calendar did not. The missing source is named in the header, not hidden." },
    offline: { label: "Offline", note: "Cached rows stay readable and every action that needs the network is disabled with a reason." },
  },
  groups: [
    { name: "row", inner: 8, outer: 20, items: 5 },
    { name: "section", inner: 20, outer: 52, items: 3 },
  ],
  destructive: [{ action: "dismiss", undo: true, note: "Undo for 8s in the same row; no dialog." }],
  audit: {
    budget: 16,
    elements: 13,
    absorbs: "ranking five heterogeneous sources into one order, and explaining the rank in one clause per row",
    transfers: "the user still picks which row to act on; the product does not act unasked",
    claim: "median time from open to first action, measured, not the number of taps",
  },
  flow: [
    { node: "open", to: ["read"] },
    { node: "read", to: ["resolve", "snooze"] },
    { node: "resolve", terminal: true, residue: "the row leaves and the count drops" },
    { node: "snooze", terminal: true, residue: "the row returns at the named time, not vaguely later" },
    { node: "source-unreachable", failure: true, residue: "cached rows remain, the header names what is missing" },
  ],
};
