/**
 * Read-only navigator renderer.
 *
 * Produces the HTML, CSS, and client script served by `server.mjs`. Artifact
 * text is never interpolated into markup here; the client fetches JSON and
 * assigns it through `textContent`, so hostile Markdown, embedded HTML, and
 * scripts remain inert.
 *
 * The stylesheet and client script are served as separate same-origin
 * resources so the Content-Security-Policy can forbid inline script and style
 * entirely. That policy also forbids images, web fonts, and every remote
 * asset, so the whole visual system is built from system font stacks, color,
 * and CSS geometry.
 */

const HTML_ESCAPES = Object.freeze({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
});

/** Escape a value for interpolation into HTML text or an attribute value. */
export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export const ARTIFACT_READING_STEPS = Object.freeze([
    Object.freeze({ type: "research", position: 1, label: "Research" }),
    Object.freeze({ type: "plan", position: 2, label: "Plan" }),
    Object.freeze({ type: "phase-details", position: 3, label: "Details" }),
    Object.freeze({ type: "plan-critique", position: 4, label: "Critique" }),
    Object.freeze({ type: "changes", position: 5, label: "Changes" }),
    Object.freeze({ type: "review-log", position: 6, label: "Review" }),
]);

export const STATUS_TONE_RULES = Object.freeze([
    Object.freeze({ tone: "danger", terms: Object.freeze(["blocked", "failed", "error", "not accepted"]) }),
    Object.freeze({ tone: "attention", terms: Object.freeze(["in progress", "partial", "revise", "needs clarification"]) }),
    Object.freeze({ tone: "success", terms: Object.freeze(["complete", "passed", "conformant", "accepted"]) }),
    Object.freeze({ tone: "accent", terms: Object.freeze(["ready"]) }),
]);

const ARTIFACT_READING_POSITIONS = new Map(ARTIFACT_READING_STEPS.map((step) => [step.type, step.position]));

export function classifyStatusTone(status) {
    const normalized = String(status ?? "").trim().toLowerCase();
    for (const rule of STATUS_TONE_RULES) {
        if (rule.terms.some((term) => normalized.includes(term))) return rule.tone;
    }
    return "neutral";
}

export function compareArtifactsForReading(left, right) {
    const leftPosition = ARTIFACT_READING_POSITIONS.get(left.type) ?? Number.POSITIVE_INFINITY;
    const rightPosition = ARTIFACT_READING_POSITIONS.get(right.type) ?? Number.POSITIVE_INFINITY;
    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    if (left.modifiedAt !== right.modifiedAt) return left.modifiedAt < right.modifiedAt ? 1 : -1;
    return left.id.localeCompare(right.id);
}

export const NAVIGATOR_STYLES = `
:root {
  color-scheme: light dark;
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --radius: 6px;

  --canvas: #ffffff;
  --canvas-subtle: #f6f8fa;
  --canvas-inset: #f6f8fa;
  --canvas-hover: #eef1f4;
  --canvas-active: #e6eaef;
  --border: #d1d9e0;
  --border-strong: #818b98;
  --fg: #1f2328;
  --fg-muted: #59636e;
  --accent: #0969da;
  --accent-solid: #0969da;
  --accent-on-solid: #ffffff;
  --accent-subtle: #ddf4ff;
  --success: #1a7f37;
  --attention: #9a6700;
  --severe: #bc4c00;
  --danger: #cf222e;
  --done: #8250df;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0d1117;
    --canvas-subtle: #151b23;
    --canvas-inset: #010409;
    --canvas-hover: #212830;
    --canvas-active: #2a313c;
    --border: #3d444d;
    --border-strong: #6e7681;
    --fg: #f0f6fc;
    --fg-muted: #9198a1;
    --accent: #4493f8;
    --accent-solid: #1f6feb;
    --accent-on-solid: #ffffff;
    --accent-subtle: #121d2f;
    --success: #3fb950;
    --attention: #d29922;
    --severe: #db6d28;
    --danger: #f85149;
    --done: #ab7df8;
  }
}

* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  font: 400 0.875rem/1.5 var(--font-ui);
  background: var(--canvas);
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
h1, h2, p, dl, dd, pre, ul { margin: 0; }
ul { list-style: none; padding: 0; }

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 20;
  padding: 0.5rem 0.75rem;
  background: var(--accent-solid);
  color: var(--accent-on-solid);
  font-size: 0.8125rem;
  border-radius: 0 0 var(--radius) 0;
}
.skip-link:focus { left: 0; top: 0; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.item:focus-visible, .meta__head:focus-visible { outline-offset: -2px; }

/* Shell -------------------------------------------------------------- */

.app { display: flex; flex-direction: column; height: 100dvh; }

.topbar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.0625rem 0.625rem;
  padding: 0.5rem 0.625rem 0.5rem 0.875rem;
  border-bottom: 1px solid var(--border);
  background: var(--canvas);
}
h1 {
  grid-column: 1;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.003em;
  overflow-wrap: anywhere;
}
/* The control spans both text rows so it stops setting the bar's height. */
#refresh { grid-column: 2; grid-row: 1 / span 2; }
.status {
  grid-column: 1;
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-height: 1.125rem;
  font-size: 0.75rem;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.status::before {
  content: "";
  flex: none;
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background: var(--border-strong);
}
.status[data-tone="busy"]::before { background: var(--accent); animation: pulse 1.3s ease-in-out infinite; }
.status[data-tone="success"]::before { background: var(--success); }
.status[data-tone="warning"]::before { background: var(--attention); }
.status[data-tone="error"] { color: var(--danger); font-weight: 500; }
.status[data-tone="error"]::before { background: var(--danger); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* Panes -------------------------------------------------------------- */

.panes {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(15rem, 24rem) minmax(0, 1fr);
  grid-template-areas: "index document";
}
.pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.pane--index { grid-area: index; border-right: 1px solid var(--border); }
.pane--document { grid-area: document; }

.pane__inner { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.pane__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4375rem 0.75rem;
  background: var(--canvas-subtle);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.pane__head h2 {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.pane__count {
  margin-left: auto;
  font: 400 0.75rem/1 var(--font-mono);
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
.pane__toolbar {
  flex: 0 0 auto;
  position: relative;
  padding: 0.4375rem 0.625rem;
  border-bottom: 1px solid var(--border);
  background: var(--canvas);
}
.pane__body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }

/* Filter ------------------------------------------------------------- */

.filter__input {
  width: 100%;
  font: 400 0.8125rem/1.5 var(--font-ui);
  padding: 0.3125rem 2rem 0.3125rem 0.5rem;
  color: var(--fg);
  background: var(--canvas);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
}
.filter__input::placeholder { color: var(--fg-muted); }
.filter__input:focus { border-color: var(--accent); }
.filter__hint {
  position: absolute;
  right: 1.125rem;
  top: 50%;
  transform: translateY(-50%);
  padding: 0 0.3125rem;
  font: 400 0.75rem/1.5 var(--font-mono);
  color: var(--fg-muted);
  background: var(--canvas);
  border: 1px solid var(--border);
  border-radius: 3px;
  pointer-events: none;
  transition: opacity 120ms ease;
}
.filter__input:focus ~ .filter__hint,
.filter__input:not(:placeholder-shown) ~ .filter__hint { opacity: 0; }
/* List items --------------------------------------------------------- */

.group__label {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  padding: 0.5rem 0.75rem 0.25rem;
  background: var(--canvas);
  font: 500 0.75rem/1.4 var(--font-mono);
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
.group__count { margin-left: auto; font-variant-numeric: tabular-nums; }

.item {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "title flag"
    "meta flag";
  column-gap: 0.5rem;
  width: 100%;
  text-align: left;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  border-left: 2px solid transparent;
  padding: 0.375rem 0.75rem 0.4375rem calc(2rem - 2px);
  cursor: pointer;
  overflow-wrap: anywhere;
  transition: background-color 120ms ease;
}
.artifact-step {
  position: relative;
}
.artifact-step::before {
  content: "";
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  left: 0.9975rem;
  width: 1px;
  background: var(--border);
  pointer-events: none;
}
.artifact-step:first-child::before { top: 1.0625rem; }
.artifact-step:last-child::before { bottom: calc(100% - 1.0625rem); }
.artifact-step::after {
  content: "";
  position: absolute;
  z-index: 2;
  top: 0.875rem;
  left: 0.8125rem;
  width: 0.4375rem;
  height: 0.4375rem;
  border: 2px solid var(--canvas);
  border-radius: 50%;
  background: var(--border-strong);
  pointer-events: none;
}
.artifact-step--other::after {
  border: 1px solid var(--border-strong);
  background: var(--canvas);
}
.artifact-step--current::after {
  background: var(--accent);
}
.item:hover { background: var(--canvas-hover); }
.item:active { background: var(--canvas-active); }
.item[aria-current="true"] { background: var(--accent-subtle); border-left-color: var(--accent); }
.item[aria-current="true"] .item__title { font-weight: 600; }
.item__title { grid-area: title; display: block; min-width: 0; font-size: 0.8125rem; line-height: 1.4; }
.item__meta {
  grid-area: meta;
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  margin-top: 0.1875rem;
  font-size: 0.75rem;
  color: var(--fg-muted);
}
.item__flag {
  grid-area: flag;
  align-self: center;
  flex: none;
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background: var(--accent);
}
@keyframes settle { from { background-color: var(--accent-subtle); } to { background-color: transparent; } }
.item[data-changed="true"]:not([aria-current="true"]) { animation: settle 1100ms ease-out 1; }

.kind { display: inline-flex; align-items: center; font-weight: 500; color: var(--fg); }

.time { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.item__state {
  min-width: 0;
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  justify-self: end;
  color: var(--fg);
  font-weight: 500;
}
.item__state[data-tone="accent"] { color: var(--accent); }
.item__state[data-tone="success"] { color: var(--success); }
.item__state[data-tone="attention"] { color: var(--attention); }
.item__state[data-tone="danger"] { color: var(--danger); }

.pill {
  display: inline-block;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  padding: 0 0.375rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--canvas-subtle);
  color: var(--fg-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

/* Document ----------------------------------------------------------- */

.back {
  display: none;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
  padding: 0.25rem 0.5rem 0.25rem 0.375rem;
  font: 500 0.75rem/1.5 var(--font-ui);
  color: var(--fg-muted);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
}
.back:hover { color: var(--fg); background: var(--canvas-subtle); border-color: var(--border); }
.back::before {
  content: "";
  flex: none;
  width: 0.4375rem;
  height: 0.4375rem;
  border-left: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}

.doc__head {
  flex: 0 0 auto;
  padding: 0.875rem 0.875rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--canvas);
}
#document-title {
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.006em;
  text-transform: none;
  color: var(--fg);
  overflow-wrap: anywhere;
}
/* One identity line under the title: what kind, what state, how fresh, and the
   way into the full record. The record itself is reference material and stays
   folded, so the header costs two bands instead of five. */
.doc__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3125rem 0.625rem;
  margin-top: 0.3125rem;
  font-size: 0.75rem;
  color: var(--fg-muted);
}
.doc__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3125rem 0.625rem;
}
.doc__chips:empty { display: none; }

.record__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.375rem 0.125rem 0.25rem;
  font: 400 0.75rem/1.5 var(--font-ui);
  color: var(--fg-muted);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
}
.record__toggle[hidden] { display: none; }
.record__toggle:hover { color: var(--fg); background: var(--canvas-subtle); border-color: var(--border); }
.record__toggle::before {
  content: "";
  flex: none;
  width: 0.4375rem;
  height: 0.4375rem;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 160ms ease;
}
.record__toggle[aria-expanded="true"]::before { transform: rotate(45deg); }

.record {
  flex: 0 0 auto;
  padding: 0.75rem 0.875rem 0.875rem;
  border-bottom: 1px solid var(--border);
  background: var(--canvas-subtle);
}
.record[hidden] { display: none; }
dl.metadata {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0.3125rem 0.875rem;
  font-size: 0.75rem;
}
dt { color: var(--fg-muted); }
dd { font-family: var(--font-mono); overflow-wrap: anywhere; }
dd.metadata__path { display: flex; align-items: baseline; gap: 0.5rem; }
dd.metadata__path span { min-width: 0; overflow-wrap: anywhere; }

pre.source {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  /* Hold the reading measure near 80 characters on a wide pane without
     centering the column, which no code surface does. */
  padding: 0.875rem max(1rem, calc(100% - 82ch)) 1.5rem 1rem;
  background: var(--canvas);
  color: var(--fg);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 400 0.75rem/1.7 var(--font-mono);
  tab-size: 4;
}
pre.source[hidden] { display: none; }

.doc__empty {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 1.25rem 1rem 1.5rem;
  max-width: 62ch;
  color: var(--fg-muted);
  font-size: 0.8125rem;
}
.doc__empty[hidden] { display: none; }
.doc__empty p { margin-bottom: 0.75rem; }
.doc__empty-lead { color: var(--fg); font-weight: 600; }
.doc__empty h3 {
  margin: 1.25rem 0 0.4375rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.doc__keys li { display: flex; align-items: baseline; gap: 0.625rem; padding: 0.125rem 0; }
.key {
  flex: none;
  min-width: 1.75rem;
  text-align: center;
  padding: 0 0.3125rem;
  font: 400 0.75rem/1.5 var(--font-mono);
  color: var(--fg);
  background: var(--canvas-subtle);
  border: 1px solid var(--border);
  border-radius: 3px;
}

/* Controls ----------------------------------------------------------- */

button.btn {
  font: 500 0.75rem/1.5 var(--font-ui);
  padding: 0.3125rem 0.625rem;
  color: var(--fg);
  background: var(--canvas-subtle);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}
button.btn:hover { background: var(--canvas-hover); }
button.btn:active { background: var(--canvas-active); }
button.btn[disabled] { color: var(--fg-muted); border-color: var(--border); cursor: default; }
button.btn--quiet { flex: none; background: none; border-color: var(--border); }
button.btn--quiet:hover { background: var(--canvas-hover); border-color: var(--border-strong); }

button.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  color: var(--fg-muted);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius);
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
}
button.icon-btn:hover { color: var(--fg); background: var(--canvas-subtle); border-color: var(--border); }
button.icon-btn:active { background: var(--canvas-active); }
button.icon-btn[disabled] { color: var(--border-strong); background: none; border-color: transparent; cursor: default; }
.icon { display: block; }

/* Empty and loading states -------------------------------------------- */

.empty { padding: 0.875rem 0.75rem 1rem; color: var(--fg-muted); font-size: 0.75rem; }
.empty__title { display: block; margin-bottom: 0.3125rem; color: var(--fg); font-size: 0.8125rem; font-weight: 600; }
.empty__roots { margin-top: 0.5rem; font-family: var(--font-mono); font-size: 0.75rem; }
.empty__roots li { padding: 0.0625rem 0; }

.skeleton { padding: 0.5rem 0.75rem; }
.skeleton__row { padding: 0.375rem 0; }
.skeleton__bar { height: 0.5rem; border-radius: 3px; background: var(--border); animation: shimmer 1.5s ease-in-out infinite; }
.skeleton__bar + .skeleton__bar { margin-top: 0.375rem; width: 55%; }
.skeleton__row:nth-child(2) .skeleton__bar { width: 78%; }
.skeleton__row:nth-child(3) .skeleton__bar { width: 64%; }
.skeleton__row:nth-child(2) .skeleton__bar + .skeleton__bar { width: 40%; }
.skeleton__row:nth-child(3) .skeleton__bar + .skeleton__bar { width: 48%; }
@keyframes shimmer { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* Responsive --------------------------------------------------------- */

@media (max-width: 60rem) {
  .panes { grid-template-columns: minmax(11rem, 17rem) minmax(0, 1fr); }
}

/* Below this width the two panes stop being neighbours and become two views.
   Showing a truncated index above a truncated document serves neither. */
@media (max-width: 40rem) {
  .panes { display: block; position: relative; }
  .pane {
    position: absolute;
    inset: 0;
    border-right: 0;
  }
  .app[data-view="list"] .pane--document,
  .app[data-view="document"] .pane--index { display: none; }
  /* One view at a time needs no section label: the top bar names the panel
     and the status line already carries the count. */
  .pane--index .pane__head { display: none; }
  .back { display: inline-flex; }
  .doc__head { padding-top: 0.5rem; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`;

export const NAVIGATOR_SCRIPT = String.raw`
(function () {
  "use strict";

  // The document is served at the capability base path, so the base is derived
  // from the current location instead of being injected inline. This lets the
  // Content-Security-Policy forbid inline script entirely.
  var base = window.location.pathname.replace(/\/+$/, "");

  var APPROVED_ROOTS = [
    ".copilot-tracking/research",
    ".copilot-tracking/plans",
    ".copilot-tracking/details",
    ".copilot-tracking/changes",
    ".copilot-tracking/reviews/plans",
    ".copilot-tracking/reviews/logs"
  ];

  var KIND_LABELS = {
    "research": "Research",
    "plan": "Plan",
    "phase-details": "Details",
    "changes": "Changes",
    "plan-critique": "Critique",
    "review-log": "Review",
    "unknown": "Artifact"
  };

  var READING_STEPS = ${JSON.stringify(ARTIFACT_READING_STEPS)};
  var STATUS_TONE_RULES = ${JSON.stringify(STATUS_TONE_RULES)};

  var state = {
    artifacts: [],
    selectedId: null,
    document: null,
    targetRevision: -1,
    query: "",
    changed: Object.create(null),
    flash: Object.create(null),
    loaded: false
  };

  var seenRevisions = Object.create(null);
  var seenAny = false;
  var ledgerTimer = 0;

  var statusEl = document.getElementById("status");
  var listEl = document.getElementById("artifact-list");
  var metadataEl = document.getElementById("metadata");
  var sourceEl = document.getElementById("source");
  var docEmptyEl = document.getElementById("doc-empty");
  var skipLinkEl = document.getElementById("skip-link");
  var appEl = document.getElementById("app");
  var backBtn = document.getElementById("back");
  var refreshBtn = document.getElementById("refresh");
  var recordEl = document.getElementById("record");
  var recordToggle = document.getElementById("record-toggle");
  var chipsEl = document.getElementById("doc-chips");
  var titleEl = document.getElementById("document-title");
  var filterEl = document.getElementById("filter");
  var artifactCountEl = document.getElementById("artifact-count");

  /**
   * Below 40rem the index and the document are two views rather than two
   * panes. The attribute is set at every width and only styled under that
   * breakpoint, so a resize needs no bookkeeping.
   */
  function showView(name) {
    appEl.setAttribute("data-view", name);
  }

  function setStatus(message, tone) {
    statusEl.textContent = message;
    statusEl.setAttribute("data-tone", tone || "info");
  }

  /**
   * The standing status line is the change ledger, not a restatement of the
   * open document's own header. It answers the question the visitor arrives
   * with: how much is here, and how much of it moved while they were away.
   */
  function reportLedger() {
    window.clearTimeout(ledgerTimer);
    var total = state.artifacts.length;
    var pending = 0;
    state.artifacts.forEach(function (artifact) {
      if (state.changed[artifact.id]) pending += 1;
    });
    var message = total === 1 ? "1 artifact tracked" : total + " artifacts tracked";
    if (pending > 0) message += " \u00b7 " + pending + " updated";
    setStatus(message, pending > 0 ? "success" : "info");
  }

  /** Announce a momentary result, then hand the line back to the ledger. */
  function flashStatus(message, tone) {
    setStatus(message, tone);
    window.clearTimeout(ledgerTimer);
    ledgerTimer = window.setTimeout(reportLedger, 5000);
  }

  function request(path, options) {
    var init = Object.assign({ headers: { Accept: "application/json" }, credentials: "omit" }, options || {});
    return fetch(base + path, init).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body && body.message ? body.message : "Request failed");
        return body;
      });
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function kindLabel(type) {
    return KIND_LABELS[type] || KIND_LABELS.unknown;
  }

  function readingStep(type) {
    for (var i = 0; i < READING_STEPS.length; i++) {
      if (READING_STEPS[i].type === type) return READING_STEPS[i];
    }
    return null;
  }

  function statusTone(status) {
    var normalized = String(status || "").trim().toLowerCase();
    for (var i = 0; i < STATUS_TONE_RULES.length; i++) {
      var rule = STATUS_TONE_RULES[i];
      for (var j = 0; j < rule.terms.length; j++) {
        if (normalized.indexOf(rule.terms[j]) !== -1) return rule.tone;
      }
    }
    return "neutral";
  }

  function relativeTime(iso) {
    var at = Date.parse(iso);
    if (!isFinite(at)) return "time unknown";
    var seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 45) return "just now";
    if (seconds < 5400) {
      var minutes = Math.max(1, Math.round(seconds / 60));
      return minutes === 1 ? "1 min ago" : minutes + " min ago";
    }
    if (seconds < 86400) {
      var hours = Math.round(seconds / 3600);
      return hours === 1 ? "1 hr ago" : hours + " hr ago";
    }
    if (seconds < 172800) return "yesterday";
    if (seconds < 2592000) return Math.round(seconds / 86400) + " days ago";
    return new Date(at).toISOString().slice(0, 10);
  }

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes)) return "unknown";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KiB";
    return (bytes / 1048576).toFixed(2) + " MiB";
  }

  function addTime(parent, artifact) {
    var time = el("span", "time", relativeTime(artifact.modifiedAt));
    time.setAttribute("data-mtime", artifact.modifiedAt);
    time.title = "Last modified " + artifact.modifiedAt;
    parent.appendChild(time);
    return time;
  }

  function refreshTimes() {
    var nodes = document.querySelectorAll("[data-mtime]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = relativeTime(nodes[i].getAttribute("data-mtime"));
    }
  }

  /** The one description of what the filter reaches. Copy quotes this list. */
  var FILTER_FIELDS = "title, task, kind, status, or path";

  function matchesQuery(artifact, query) {
    if (query === "") return true;
    var haystack = [artifact.title, artifact.id, artifact.taskSlug, artifact.status, kindLabel(artifact.type)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.indexOf(query) !== -1;
  }

  function groupArtifacts(artifacts) {
    var groups = [];
    var byKey = Object.create(null);
    artifacts.forEach(function (artifact) {
      var key = artifact.taskSlug || "unassigned";
      var group = byKey[key];
      if (group === undefined) {
        group = { key: key, items: [], latest: "" };
        byKey[key] = group;
        groups.push(group);
      }
      group.items.push(artifact);
      if (artifact.modifiedAt > group.latest) group.latest = artifact.modifiedAt;
    });
    function readingOrder(a, b) {
      var aStep = readingStep(a.type);
      var bStep = readingStep(b.type);
      var aPosition = aStep === null ? Number.POSITIVE_INFINITY : aStep.position;
      var bPosition = bStep === null ? Number.POSITIVE_INFINITY : bStep.position;
      if (aPosition !== bPosition) return aPosition - bPosition;
      if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
      return a.id.localeCompare(b.id);
    }
    groups.forEach(function (group) { group.items.sort(readingOrder); });
    groups.sort(function (a, b) {
      if (a.latest !== b.latest) return a.latest < b.latest ? 1 : -1;
      return a.key < b.key ? -1 : 1;
    });
    return groups;
  }

  function emptyBlock(title, detail, withRoots) {
    var li = el("li", "empty");
    li.appendChild(el("span", "empty__title", title));
    li.appendChild(document.createTextNode(detail));
    if (withRoots) {
      var list = el("ul", "empty__roots");
      APPROVED_ROOTS.forEach(function (root) { list.appendChild(el("li", null, root)); });
      li.appendChild(list);
    }
    return li;
  }

  function skeletonBlock() {
    var li = el("li", "skeleton");
    for (var i = 0; i < 3; i++) {
      var row = el("div", "skeleton__row");
      row.appendChild(el("div", "skeleton__bar"));
      row.appendChild(el("div", "skeleton__bar"));
      li.appendChild(row);
    }
    li.setAttribute("aria-hidden", "true");
    return li;
  }

  function buildItem(artifact) {
    var button = el("button", "item");
    button.type = "button";
    button.setAttribute("data-artifact-id", artifact.id);
    if (artifact.id === state.selectedId) button.setAttribute("aria-current", "true");
    if (state.flash[artifact.id]) button.setAttribute("data-changed", "true");

    button.appendChild(el("span", "item__title", artifact.title || artifact.id.split("/").pop()));

    var meta = el("span", "item__meta");
    var step = readingStep(artifact.type);
    var readingLabel = step === null ? "Other" : step.label;
    meta.appendChild(el("span", "kind", readingLabel));
    addTime(meta, artifact);
    if (artifact.status) {
      var itemState = el("span", "item__state", artifact.status);
      itemState.title = "Status " + artifact.status;
      itemState.setAttribute("data-tone", statusTone(artifact.status));
      meta.appendChild(itemState);
    }
    button.appendChild(meta);
    if (state.changed[artifact.id]) {
      var flag = el("span", "item__flag");
      flag.title = "Written since you last opened it";
      button.appendChild(flag);
    }

    var label = (artifact.title || artifact.id) + ", " + readingLabel;
    if (artifact.status) label += ", status " + artifact.status;
    if (state.changed[artifact.id]) label += ", updated";
    button.setAttribute("aria-label", label);

    button.addEventListener("click", function () { select(artifact.id, true); });
    return button;
  }

  function renderList() {
    // A live refresh rebuilds every row, so the row the visitor was standing on
    // is remembered and handed its focus back. Losing it mid-supervision is the
    // focus theft this panel exists to avoid.
    var active = document.activeElement;
    var restoreId = active && listEl.contains(active) ? active.getAttribute("data-artifact-id") : null;

    listEl.textContent = "";

    if (!state.loaded) {
      listEl.appendChild(skeletonBlock());
      artifactCountEl.textContent = "";
      return;
    }

    if (state.artifacts.length === 0) {
      artifactCountEl.textContent = "0";
      listEl.appendChild(emptyBlock(
        "No artifacts yet",
        "This panel reads Markdown the RPI workflow writes. Files appear here the moment the agent creates one in:",
        true
      ));
      return;
    }

    var query = state.query;
    var visible = state.artifacts.filter(function (artifact) { return matchesQuery(artifact, query); });
    artifactCountEl.textContent = query === ""
      ? String(state.artifacts.length)
      : visible.length + "/" + state.artifacts.length;

    if (visible.length === 0) {
      listEl.appendChild(emptyBlock(
        "Nothing matches",
        "No artifact matches \u201c" + query + "\u201d by " + FILTER_FIELDS + ".",
        false
      ));
      return;
    }

    groupArtifacts(visible).forEach(function (group) {
      var groupItem = el("li", "group");
      var label = el("p", "group__label");
      label.appendChild(document.createTextNode(group.key));
      label.appendChild(el("span", "group__count", String(group.items.length)));
      groupItem.appendChild(label);

      var sublist = el("ul");
      sublist.setAttribute("aria-label", "Artifacts for " + group.key);
      group.items.forEach(function (artifact) {
        var li = el("li");
        li.className = "artifact-step";
        if (readingStep(artifact.type) === null) li.className += " artifact-step--other";
        if (artifact.id === state.selectedId) li.className += " artifact-step--current";
        li.appendChild(buildItem(artifact));
        sublist.appendChild(li);
      });
      groupItem.appendChild(sublist);
      listEl.appendChild(groupItem);
    });

    state.flash = Object.create(null);

    if (restoreId !== null) {
      var rows = listEl.querySelectorAll("[data-artifact-id]");
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].getAttribute("data-artifact-id") === restoreId) {
          rows[r].focus();
          break;
        }
      }
    }
  }

  /**
   * The record is reference material, so it leads with the path and keeps the
   * copy control beside the value it copies rather than in the header, where a
   * bordered field outweighed the title it sat under.
   */
  function renderMetadata(doc) {
    metadataEl.textContent = "";

    metadataEl.appendChild(el("dt", null, "Path"));
    var pathDd = el("dd", "metadata__path");
    pathDd.appendChild(el("span", null, doc.id));
    var copy = el("button", "btn btn--quiet", "Copy");
    copy.type = "button";
    copy.addEventListener("click", copyPath);
    pathDd.appendChild(copy);
    metadataEl.appendChild(pathDd);

    var shortHash = typeof doc.sha256 === "string" ? doc.sha256.slice(0, 12) : "unknown";
    [
      ["Task", doc.taskSlug || "unknown"],
      ["Dated", doc.date || "unknown"],
      ["Modified", doc.modifiedAt],
      ["Size", formatBytes(doc.sizeBytes)],
      ["Headings", String(doc.headings.length)],
      ["SHA-256", shortHash]
    ].forEach(function (pair) {
      metadataEl.appendChild(el("dt", null, pair[0]));
      var dd = el("dd", null, pair[1]);
      if (pair[0] === "SHA-256") dd.title = doc.sha256;
      metadataEl.appendChild(dd);
    });
  }

  function setRecordOpen(open) {
    recordEl.hidden = !open;
    recordToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function renderChips(doc) {
    chipsEl.textContent = "";
    chipsEl.appendChild(el("span", "kind", kindLabel(doc.type)));
    if (doc.status) {
      var pill = el("span", "pill", doc.status);
      pill.title = "Status " + doc.status;
      chipsEl.appendChild(pill);
    }
    addTime(chipsEl, doc);
  }

  function renderDocument() {
    var doc = state.document;

    if (!doc) {
      titleEl.textContent = "No artifact open";
      chipsEl.textContent = "";
      recordToggle.hidden = true;
      setRecordOpen(false);
      docEmptyEl.hidden = false;
      sourceEl.hidden = true;
      metadataEl.textContent = "";
      sourceEl.textContent = "";
      showView("list");
      return;
    }

    titleEl.textContent = doc.title || doc.id.split("/").pop();
    renderChips(doc);
    recordToggle.hidden = false;
    setRecordOpen(false);
    docEmptyEl.hidden = true;
    sourceEl.hidden = false;
    renderMetadata(doc);

    // textContent keeps artifact source inert: no markup is ever parsed.
    sourceEl.textContent = doc.source;
    sourceEl.scrollTop = 0;
  }

  function select(artifactId, viaUser) {
    setStatus("Opening " + artifactId, "busy");
    return request("/api/artifact?artifactId=" + encodeURIComponent(artifactId))
      .then(function (body) {
        state.selectedId = artifactId;
        state.document = body.artifact;
        delete state.changed[artifactId];
        renderList();
        renderDocument();
        showView("document");
        // On a narrow panel the index has just left the screen, so the keyboard
        // follows it. Only a deliberate choice moves focus: an agent-driven open
        // or a background refresh must never pull the visitor out of what they
        // are doing. The offset parent is null while the control is not
        // displayed, which is exactly the wide layout where both panes stay up.
        if (viaUser && backBtn.offsetParent !== null) backBtn.focus();
        reportLedger();
      })
      .catch(function (err) {
        setStatus("Could not open the artifact: " + err.message, "error");
      });
  }

  function noteRevisions(artifacts) {
    artifacts.forEach(function (artifact) {
      var previous = seenRevisions[artifact.id];
      if (seenAny && previous !== artifact.modifiedAt && artifact.id !== state.selectedId) {
        state.changed[artifact.id] = true;
        state.flash[artifact.id] = true;
      }
      seenRevisions[artifact.id] = artifact.modifiedAt;
    });
    seenAny = true;
  }

  function applyList(body) {
    state.artifacts = body.artifacts;
    state.loaded = true;
    noteRevisions(state.artifacts);

    var nextId = state.selectedId;
    var targetChanged = Number.isInteger(body.targetRevision) && body.targetRevision > state.targetRevision;
    if (Number.isInteger(body.targetRevision)) state.targetRevision = body.targetRevision;
    if (
      targetChanged &&
      typeof body.selectedArtifactId === "string" &&
      state.artifacts.some(function (a) { return a.id === body.selectedArtifactId; })
    ) {
      nextId = body.selectedArtifactId;
      state.selectedId = nextId;
    }
    var stillPresent = state.artifacts.some(function (a) { return a.id === nextId; });
    if (nextId && !stillPresent) {
      nextId = null;
      state.selectedId = null;
      state.document = null;
      renderDocument();
    }
    renderList();
    reportLedger();
    return nextId;
  }

  function load() {
    return request("/api/artifacts")
      .then(function (body) {
        var nextId = applyList(body);
        if (nextId) return select(nextId);
        return undefined;
      })
      .catch(function (err) {
        state.loaded = true;
        renderList();
        setStatus("Could not read the tracking roots: " + err.message, "error");
      });
  }

  function refresh() {
    refreshBtn.disabled = true;
    setStatus("Re-reading the tracking roots\u2026", "busy");
    return request("/api/refresh", { method: "POST" })
      .then(function (body) {
        var nextId = applyList(body);
        if (nextId) return select(nextId);
        return undefined;
      })
      .catch(function (err) {
        setStatus("Could not refresh: " + err.message, "error");
      })
      .then(function () {
        refreshBtn.disabled = false;
      });
  }

  function copyPath() {
    var value = state.document ? state.document.id : "";
    if (value === "") return;
    var selectFallback = function () {
      try {
        var target = metadataEl.querySelector(".metadata__path span");
        if (!target) throw new Error("no path element");
        var range = document.createRange();
        range.selectNodeContents(target);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        flashStatus("Path selected. Use your clipboard shortcut to copy it.", "warning");
      } catch (err) {
        flashStatus("This panel could not reach the clipboard.", "warning");
      }
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(value).then(function () {
          flashStatus("Copied " + value, "success");
        }, selectFallback);
        return;
      }
    } catch (err) {
      // Fall through to the selection fallback below.
    }
    selectFallback();
  }

  filterEl.addEventListener("input", function () {
    state.query = filterEl.value.trim().toLowerCase();
    renderList();
  });

  filterEl.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || filterEl.value === "") return;
    filterEl.value = "";
    state.query = "";
    renderList();
    event.stopPropagation();
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    var active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    event.preventDefault();
    filterEl.focus();
    filterEl.select();
  });

  refreshBtn.addEventListener("click", refresh);
  recordToggle.addEventListener("click", function () {
    setRecordOpen(recordEl.hidden);
  });
  // The source is hidden until an artifact is open, and a narrow panel may be
  // showing the index instead, so the skip target is resolved at activation
  // rather than assumed to be on screen. The href still names a real element,
  // which keeps the link meaningful if this handler never runs.
  skipLinkEl.addEventListener("click", function (event) {
    event.preventDefault();
    showView("document");
    var target = sourceEl.hidden ? docEmptyEl : sourceEl;
    target.focus();
  });

  backBtn.addEventListener("click", function () {
    showView("list");
    var rows = listEl.querySelectorAll("[data-artifact-id]");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("aria-current") === "true") {
        rows[i].focus();
        return;
      }
    }
    filterEl.focus();
  });

  window.setInterval(refreshTimes, 60000);

  if (typeof window.EventSource === "function") {
    try {
      var events = new EventSource(base + "/api/events");
      events.addEventListener("refresh", function () { refresh(); });
    } catch (err) {
      // Live refresh notification is optional; the button remains available.
    }
  }

  renderList();
  renderDocument();
  setStatus("Reading the tracking roots\u2026", "busy");
  load();
})();
`;

/** Render the navigator document. Only escaped, provider-owned text is inlined. */
export function renderNavigatorHtml({ title } = {}) {
    const safeTitle = escapeHtml(title ?? "RPI Artifact Navigator");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>${safeTitle}</title>
<link rel="stylesheet" href="app.css" />
</head>
<body>
<!--
THESIS: a change ledger for the files an agent is writing right now, not a
generic three pane Markdown viewer whose panes are equal and inert.
OWN-WORLD: GitHub Primer chrome. Neutrals plus one accent, hairline dividers,
6px radii, system sans for chrome and ui-monospace for every path, hash, size
and source byte. Kind dots, status pills, collapsible panes.
STORY: the visitor sees which artifacts moved, opens one, and reads it whole.
FIRST VIEWPORT: hairline top bar with title, live status dot and Refresh. Below
it the Artifacts pane, filtered and grouped by task, newest task first, changed
rows carrying an accent marker. The document pane holds title, kind and status
chips, a path row with copy, collapsed details, then the source. Below 40rem the
two panes become two views, and the document owns the panel while it is open.
FORM: category canon, Primer, pinned by the user. No direction roll.
-->
<a id="skip-link" class="skip-link" href="#document-pane">Skip to content</a>
<div class="app" id="app" data-view="list">
  <header class="topbar">
    <h1>${safeTitle}</h1>
    <button id="refresh" class="icon-btn" type="button" aria-label="Refresh from disk" title="Refresh from disk">
      <svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <path d="M13.25 8a5.25 5.25 0 1 1-5.25-5.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M7.9 0.4 10.9 2.75 7.9 5.1Z" fill="currentColor" />
      </svg>
    </button>
    <p id="status" class="status" role="status" aria-live="polite" data-tone="busy">Reading the tracking roots&hellip;</p>
  </header>

  <div class="panes">
    <nav aria-labelledby="artifacts-heading" class="pane pane--index">
      <div class="pane__inner">
        <div class="pane__head">
          <h2 id="artifacts-heading">Artifacts</h2>
          <span id="artifact-count" class="pane__count"></span>
        </div>
        <div class="pane__toolbar">
          <label class="visually-hidden" for="filter">Filter artifacts</label>
          <input id="filter" class="filter__input" type="search" placeholder="Filter artifacts" autocomplete="off" spellcheck="false" />
          <span class="filter__hint" aria-hidden="true">/</span>
        </div>
        <div class="pane__body">
          <ul id="artifact-list" aria-labelledby="artifacts-heading"></ul>
        </div>
      </div>
    </nav>

    <section id="document-pane" class="pane pane--document" aria-labelledby="document-title" tabindex="-1">
      <div class="doc__head">
        <button id="back" class="back" type="button">Artifacts</button>
        <h2 id="document-title">No artifact open</h2>
        <div class="doc__meta">
          <div id="doc-chips" class="doc__chips"></div>
          <button id="record-toggle" class="record__toggle" type="button" aria-expanded="false" aria-controls="record" hidden>Metadata</button>
        </div>
      </div>
      <div id="record" class="record" hidden>
        <dl id="metadata" class="metadata"></dl>
      </div>
      <div id="doc-empty" class="doc__empty" tabindex="-1">
        <p class="doc__empty-lead">Choose an artifact, or let the agent choose one for you.</p>
        <p>This panel is a read-only view of the Markdown the RPI workflow writes. The files stay authoritative, so refreshing or reopening always re-reads them from disk. A new artifact opens the panel; an edited one refreshes it in place and is marked here until you look at it.</p>
        <h3>Keyboard</h3>
        <ul class="doc__keys">
          <li><span class="key">/</span> Filter the artifact list</li>
          <li><span class="key">Esc</span> Clear the filter</li>
        </ul>
        <h3>Roots read</h3>
        <ul class="empty__roots">
          <li>.copilot-tracking/research</li>
          <li>.copilot-tracking/plans</li>
          <li>.copilot-tracking/details</li>
          <li>.copilot-tracking/changes</li>
          <li>.copilot-tracking/reviews/plans</li>
          <li>.copilot-tracking/reviews/logs</li>
        </ul>
      </div>
      <pre id="source" class="source" tabindex="0" aria-label="Artifact source, read only"></pre>
    </section>
  </div>
</div>
<script src="app.js" defer></script>
</body>
</html>`;
}
