---
name: RPI Artifact Navigator
description: A read-only change ledger for the Markdown an AI agent is writing mid-RPI-loop, dressed as native GitHub Primer chrome.
colors:
  canvas: "#ffffff"
  canvas-subtle: "#f6f8fa"
  canvas-inset: "#f6f8fa"
  canvas-hover: "#eef1f4"
  canvas-active: "#e6eaef"
  border: "#d1d9e0"
  border-strong: "#818b98"
  fg: "#1f2328"
  fg-muted: "#59636e"
  accent: "#0969da"
  accent-solid: "#0969da"
  accent-on-solid: "#ffffff"
  accent-subtle: "#ddf4ff"
  success: "#1a7f37"
  attention: "#9a6700"
  severe: "#bc4c00"
  danger: "#cf222e"
  done: "#8250df"
typography:
  document-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans\", Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.006em"
  app-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans\", Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.003em"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans\", Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.03em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans\", Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  item-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans\", Helvetica, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Noto Sans\", Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: "normal"
rounded:
  xs: "3px"
  md: "6px"
  pill: "999px"
  circle: "50%"
spacing:
  "2xs": "0.25rem"
  xs: "0.375rem"
  sm: "0.5rem"
  md: "0.625rem"
  lg: "0.75rem"
  xl: "0.875rem"
components:
  button-primary:
    backgroundColor: "{colors.canvas-subtle}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "0.3125rem 0.625rem"
  button-quiet:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "0.3125rem 0.625rem"
  button-back:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.md}"
    padding: "0.25rem 0.5rem 0.25rem 0.375rem"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.md}"
    padding: "0"
    size: "1.75rem"
  filter-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "0.3125rem 2rem 0.3125rem 0.5rem"
  item:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.fg}"
    padding: "0.375rem 0.75rem 0.4375rem calc(0.75rem - 2px)"
  item-current:
    backgroundColor: "{colors.accent-subtle}"
    textColor: "{colors.fg}"
  pill:
    backgroundColor: "{colors.canvas-subtle}"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.pill}"
    padding: "0 0.375rem"
  record-toggle:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.md}"
    padding: "0.125rem 0.375rem 0.125rem 0.25rem"
  keycap:
    backgroundColor: "{colors.canvas-subtle}"
    textColor: "{colors.fg}"
    rounded: "{rounded.xs}"
    padding: "0 0.3125rem"
---

# Design System: RPI Artifact Navigator

## Overview

**Creative North Star: "Native Chrome, Not an App"**

This is a canvas panel that opens itself inside the GitHub Copilot app while an
engineer supervises an agent running a Research → Plan → Implement → Review
loop. Its whole ambition is to look like it was always part of the host — a
GitHub Primer surface executed at full fidelity, not a quirky reading of it.
The palette is Primer's neutrals plus a single blue accent, dividers are
hairlines, corners are a quiet 6px, and every path, hash, and source byte is set
in the system monospace. Convention is the commitment. If a visitor cannot tell
whether this shipped with the app, the surface has done its job.

The panel is a *change ledger*, not a generic two-pane Markdown viewer. It
holds the previous modified-time of every artifact, so the one thing it does
that a plain file tree cannot is tell the visitor what moved while they were
away. That single idea earns the design's only reserved uses of color: the
accent marks selection, focus, and change, and nothing else.
Everything visible is drawn from a system font stack, a color, CSS geometry, or
an inline SVG authored directly in the markup — the served Content-Security-Policy
forbids *fetched* images, icon fonts, web fonts, remote assets, `data:` URLs, and
any inline style or script, so the chevrons, status dots, change markers, and
keycaps are borders and radii, and the panel's one icon (the refresh glyph) is an
inline `<svg>` element in the document, never a downloaded asset.

The world is deliberately restrained and unobtrusive. It rejects decorative
color, novelty, and motion-for-motion's-sake. There is no elevation vocabulary
at all — depth is tonal, built from a five-step canvas ramp and hairline
borders, never a shadow. Density is high and calm: this tool is meant to
disappear into the task, because the engineer is supervising an agent, not
admiring a UI.

**Key Characteristics:**
- GitHub Primer neutrals plus one blue accent; no second hue for decoration.
- Every mark is a system font, a color, CSS geometry, or an inline authored SVG — never a fetched image or font of any kind.
- Flat by design: tonal layering and hairlines, zero shadows.
- Monospace is reserved for machine facts (paths, hashes, sizes, times, slugs, counts).
- Motion is nearly silent: one change-settle, one busy-pulse, one loading-shimmer.
- Full light and dark token sets, switched by `prefers-color-scheme`.

## Colors

A Primer-derived neutral field with one working blue and a reserved bench of
state hues. The frontmatter carries the light theme as canonical; a complete
dark counterpart ships in the `prefers-color-scheme: dark` block and is mirrored
in `.impeccable/design.json`.

### Primary
- **Primer Blue** (`#0969da` light / `#4493f8` dark, `--accent`): The only
  accent. It marks a selected row (as a left border plus `--accent-subtle`
  fill), the focus ring, and the change marker dot on artifacts written since
  the visitor last looked. `--accent-solid`
  (`#0969da` / `#1f6feb`) backs the skip link with `--accent-on-solid` (`#ffffff`)
  text; `--accent-subtle` (`#ddf4ff` / `#121d2f`) is the selection wash and the
  color the settle animation fades from.

### Neutral
- **Canvas** (`#ffffff` / `#0d1117`, `--canvas`): The base surface — body, top
  bar, filter field, source pane.
- **Canvas Subtle** (`#f6f8fa` / `#151b23`, `--canvas-subtle`): Pane headings,
  pills, keycaps, and the default button fill — the quiet raised tone.
- **Canvas Inset** (`#f6f8fa` / `#010409`, `--canvas-inset`): The recessed
  inset tone at the bottom of the canvas ramp. In dark mode it goes darker than
  the canvas to read as a well.
- **Canvas Hover / Active** (`#eef1f4` / `#212830`, `#e6eaef` / `#2a313c`): Row
  and button interaction tones, one step apart.
- **Border** (`#d1d9e0` / `#3d444d`, `--border`): Hairline dividers between
  panes, rows, and sections — the lighter of the two strokes.
- **Border Strong** (`#818b98` / `#6e7681`, `--border-strong`): The stroke on
  interactive controls (buttons, the filter field) so they clear 3:1 against
  their own fill.
- **Foreground** (`#1f2328` / `#f0f6fc`, `--fg`): Primary text.
- **Foreground Muted** (`#59636e` / `#9198a1`, `--fg-muted`): Metadata, labels,
  counts, placeholders, chevrons, and the resting status dot.

### State hues (status line only)
- **Success** (`#1a7f37` / `#3fb950`), **Attention** (`#9a6700` / `#d29922`),
  **Severe** (`#bc4c00` / `#db6d28`), **Danger** (`#cf222e` / `#f85149`),
  **Done** (`#8250df` / `#ab7df8`). These color the live status region's dot and,
  for errors, its text. They are a reserved palette; do not spend them on chrome.

### Named Rules
**The Reserved Accent Rule.** Blue means one of exactly three things: this is
selected, this has focus, or this changed. It is never a decoration or a brand
flourish. Its rarity is what makes the change marker legible at a glance.

**The Uncolored Category Rule.** Artifact kind (Research, Plan, Details,
Changes, Critique, Review) carries **no** color — it is a weighted `--fg` label,
not a chip. On a Primer surface a green or amber chip reads as *state*, so
coloring category would lie about status. Category is typography; status is
color.

**The Strong-Border Control Rule.** Interactive controls stroke with
`--border-strong`; structural dividers stroke with the lighter `--border`. The
heavier stroke is not stylistic — it is how a button or field clears 3:1
contrast against its own background while dividers stay quiet.

## Typography

**UI Font:** system sans — `-apple-system, BlinkMacSystemFont, "Segoe UI",
"Noto Sans", Helvetica, Arial, sans-serif` (`--font-ui`)
**Mono Font:** system monospace — `ui-monospace, SFMono-Regular, "SF Mono",
Menlo, Consolas, "Liberation Mono", monospace` (`--font-mono`)

**Character:** No web fonts are loadable, so the type *is* the host's own — the
panel inherits whatever the OS calls native. The pairing is purely functional:
sans for everything a human reads, mono for everything a machine emitted.

### Hierarchy
- **Document Title** (600, `1rem`/16px, line-height 1.35, letter-spacing
  -0.006em): The open artifact's H1 in the document pane header.
- **App Title** (600, `0.875rem`/14px, line-height 1.4, letter-spacing -0.003em):
  The panel name (`h1`) in the top bar — two tight rows tall with the status line.
- **Label** (600, `0.75rem`/12px, letter-spacing 0.03em, UPPERCASE, muted): The
  Artifacts pane heading and empty-state subheads.
- **Body** (400, `0.875rem`/14px, line-height 1.5): The base document text size.
- **Item Title** (400→600 when current, `0.8125rem`/13px, line-height 1.4):
  Artifact row titles.
- **Meta** (400, `0.75rem`/12px): Row metadata, status line, the document
  identity line (kind label · status pill · relative time · the "Metadata"
  toggle), and the metadata grid.
- **Mono / Source** (400, `0.75rem`/12px, line-height 1.7, tab-size 4): The
  artifact source, plus every path, hash, size, timestamp, task slug, and count.

### Named Rules
**The 12px Floor Rule.** Nothing renders below `0.75rem` (12px). Counts, hints,
and the source all sit exactly on the floor; there is no smaller step.

**The Monospace-for-Facts Rule.** Monospace is reserved for values the system
produced verbatim — file paths, SHA-256 hashes, byte sizes, timestamps, task
slugs, counts, and the artifact source. It is never used decoratively or for
prose. Mono on this surface signals "this is exact."

## Layout

A full-height (`100dvh`) shell that never scrolls its body — only the inner
panes do. The top bar is a tight two-column grid (`minmax(0, 1fr) auto`, `gap:
0.0625rem 0.625rem`, `padding: 0.5rem 0.625rem 0.5rem 0.875rem`): the `h1` and
the `.status` line stack in `grid-column: 1` (two tight text rows), and the
refresh **icon button** takes `grid-column: 2; grid-row: 1 / span 2`, so the
control is centred against both rows instead of setting the bar's height. The
change ledger — a header whose real content is the status line — reads first,
with a quiet control at the right edge. Below it, two panes are laid out on a CSS
grid (`grid-template-areas: "index document"`):

- **Wide (default):** two columns — `minmax(15rem, 24rem)` Artifacts index and
  `minmax(0, 1fr)` Document.
- **≤ 60rem:** still two columns; the index narrows to `minmax(11rem, 17rem)`
  and the Document keeps the rest. *(This breakpoint is contractual — the test
  suite asserts the literal `max-width: 60rem`.)*
- **≤ 40rem:** the two panes stop being neighbours and become a master–detail
  pair of **views**. `.panes` switches to `display: block; position: relative`,
  each `.pane` is absolutely positioned to fill it, and `.app[data-view="list"|
  "document"]` on the shell decides which one shows. A `.back` control
  ("Artifacts", chevron drawn from borders) appears at the top of the document
  head (`display: none` wide, `inline-flex` narrow), and the index pane's static
  head hides because the top bar already names the panel and the status line
  carries the count.

`showView()` sets `data-view` on the shell at *every* width and only the narrow
media query styles it, so resizing needs no bookkeeping. `select(artifactId,
viaUser)` moves focus to the back control only on a deliberate click — an
agent-driven open or a background refresh never pulls focus (the back control's
`offsetParent` is `null` at wide, which is exactly where both panes stay up).

**The Document Header.** The header leads with the title and supports it with a
single identity line, then folds the reference material away. `.doc__head`
(padding `0.875rem 0.875rem 0.75rem` — more air above the heading than below it)
holds the `#document-title` H1 with the `.doc__meta` identity line `0.3125rem`
beneath it: the kind label, status pill, relative time, and an inline
`Metadata` toggle. The full record is a separate `--canvas-subtle` band
(`.record`) below the header, folded by default. So the header costs two bands
(three below 40rem, where the `.back` control shows), never the five stacked
full-width bands it replaced.

**Spacing rhythm.** Padding and gaps step through a small rem set —
`0.25 / 0.375 / 0.5 / 0.625 / 0.75 / 0.875rem`, with a couple of `0.4375rem` and
`0.0625rem` half-steps for the tightest bands. Panes, rows, and the newly
tightened top bar are dense; the document header carries the most air.

**The Reading Measure.** The source pane holds its line length near 80
characters on a wide pane *without centering the column*, via `padding-right:
max(1rem, calc(100% - 82ch))`. No code surface centers text, so the measure is
enforced from the right edge only; its trailing padding is a plain `1.5rem`.

## Elevation & Depth

**No shadows. Anywhere.** This system has no `box-shadow`, no blur, no lift.
Depth is entirely tonal: a five-step canvas ramp (`--canvas` →
`--canvas-subtle` → `--canvas-inset` → `--canvas-hover` → `--canvas-active`)
plus hairline `--border` dividers do all the layering. A recessed well reads as
inset because `--canvas-inset` is a different tone, not because of an inner
shadow.

### Named Rules
**The No-Shadow Rule.** Surfaces never lift off the page. If something needs to
read as raised, recessed, or interactive, it changes tone or gains a border — it
never casts a shadow. This keeps the panel flush with Primer, which layers the
same way.

## Shapes

One quiet radius does most of the work: **6px** (`--radius`) on buttons, the
filter field, the back control, the metadata toggle, and the skip link corner.
Small utilitarian elements — the filter keycap hint, keyboard keycaps, and
skeleton bars — use a tighter **3px**. Pills are fully rounded (`999px`).
Everything round — status dots, the change-marker dot, the busy indicator — is a
`50%` circle drawn with `border-radius` on a `~0.4375rem` box. The chevrons are
pure geometry: the metadata toggle's chevron is a small box with a right and
bottom border rotated `-45deg`, flipping to `45deg` when the disclosure is open
(`[aria-expanded="true"]`); the back control's is a left and bottom border
rotated `45deg` to point left. Every mark here is CSS geometry — a rectangle, a
radius, or a rotated border — with one deliberate exception: the top bar's refresh
control holds an inline `<svg>` icon (a stroked 270° arc plus a filled arrowhead)
authored directly in the markup, drawn in `currentColor` so the button's state
colors drive it. That SVG is an element in the document, not a fetched asset, so
it sits inside the CSP, not against it.

### Named Rules
**The Authored, Never Fetched Rule.** A mark may be CSS geometry (a border, a
radius, a rotated edge) or an inline `<svg>` authored directly in the markup — but
never a fetched resource. The CSP's `img-src 'none'` governs *fetches* (`<img>`,
CSS `url()`), so it does not touch inline SVG, which is an element in the
document. Two hard constraints on any inline SVG in this surface: it carries **no
`xmlns` attribute** (the HTML parser assigns the SVG namespace automatically, and
the literal `xmlns="http://www.w3.org/2000/svg"` would introduce an `http://`
string the test suite forbids in the emitted document), and **no `style`
attribute** (inline styles are blocked by `style-src 'self'`; use presentation
attributes like `fill`, `stroke`, `stroke-width`, `stroke-linecap` instead, and
`currentColor` to inherit state colors). Still forbidden, unchanged: fetched
images, icon fonts, web fonts, `data:` URLs, remote assets of any kind, and
inline `<style>` or `<script>`.

## Components

### Buttons
- **Shape:** 6px radius (`--radius`); text buttons pad `0.3125rem 0.625rem`,
  weight 500, `nowrap`.
- **Base (`.btn`):** `--canvas-subtle` fill, `--fg` text, `--border-strong`
  stroke. Hover → `--canvas-hover`; active → `--canvas-active`; `[disabled]` →
  `--fg-muted` text with the lighter `--border`. It now backs only the quiet
  variant below — the top bar's refresh is the icon button, so no standalone
  primary text button remains in the markup.
- **Quiet (`.btn--quiet`):** transparent fill on the lighter `--border`; hover
  fills `--canvas-hover` and *strengthens* its border to `--border-strong`.
  Used for the inline `Copy` button beside the Path value in the metadata record.
- **Icon (`.icon-btn`):** the top bar's refresh control. A `1.75rem` square with
  `padding: 0`, a transparent border, and `--fg-muted` foreground. Hover → `--fg`
  on a `--canvas-subtle` fill with a `--border` edge; active → `--canvas-active`;
  `[disabled]` → `--border-strong` foreground, transparent border, default cursor
  (it disables while a refresh is in flight, then re-enables). Its accessible name
  is `aria-label="Refresh from disk"` with a matching `title` for the tooltip; it
  keeps `id="refresh"`. It is deliberately **not** animated while refreshing — the
  busy status dot already pulses, and the surface allows only one authored motion
  at a time. Its glyph is an inline authored `<svg class="icon">` (`viewBox="0 0
  16 16"`, `aria-hidden="true"`, `focusable="false"`): a stroked 270° arc plus a
  filled arrowhead in `currentColor` (see the Authored, Never Fetched Rule).

### Chips & Pills
- **Status pill (`.pill`):** `--canvas-subtle` fill, `--border` stroke,
  `--fg-muted` text, fully rounded (`999px`), `max-width: 12rem` with ellipsis.
  Carries the parsed artifact status ("in progress", etc.). It is neutral — a
  pill is not a colored badge.
- **Kind label (`.kind`):** inline, weight 500, `--fg`, *no* background or
  border. Category is a weighted word, never a chip (see the Uncolored Category
  Rule).

### Inputs / Fields
- **Filter (`.filter__input`):** `type="search"`, full-width, `--canvas` fill,
  `--border-strong` stroke, 6px radius, `0.8125rem` text. Focus shifts the border
  to `--accent` (no glow). A monospace `/` keycap hint sits at the right edge and
  fades out on focus or once the field has text. Press `/` anywhere to focus it;
  `Esc` clears it.

### Navigation (signature)
- **Landmark.** The Artifacts index pane is the `<nav>` landmark
  (`<nav aria-labelledby="artifacts-heading" class="pane pane--index">`) — the
  artifact list *is* the navigation. *(The test suite asserts the
  `<nav aria-labelledby=` markup.)*
- **Master–detail back control (`.back`).** Below 40rem, where the index and
  document are two views instead of two panes, a quiet button at the top of the
  document head returns to the list. `--fg-muted` text on a transparent border,
  a left-pointing CSS chevron, 6px radius; hover fills `--canvas-subtle` and
  gains a `--border`. It is `display: none` at wide and `inline-flex` at narrow,
  and only a deliberate open moves focus to it.

### Metadata Record (signature)
- The document's full record is a **button-plus-panel disclosure**, not a
  `<details>`. An inline `Metadata` toggle (`.record__toggle`) sits on the
  `.doc__meta` identity line — a compact button, not a band — wired as a real
  ARIA disclosure (`aria-expanded` plus `aria-controls="record"`) with a
  CSS chevron that rotates on `[aria-expanded="true"]`. It is `hidden` while no
  artifact is open. Its label is **"Metadata"**, chosen over "Details" so it
  cannot be mistaken for the *Details* artifact kind.
- The panel it controls (`.record`) is a `--canvas-subtle` band below the
  header, `hidden` by default and re-collapsed on every document render. It
  holds `dl.metadata` (`dt` muted label / `dd` monospace value; the panel owns
  the padding). Rows are **Path** (new, and leading — a `dd.metadata__path` flex
  row of the value plus a quiet `Copy` button), Task, Dated, Modified, Size,
  Headings, and SHA-256. Kind is *not* in the grid; the identity line already
  carries it.
- The index pane's header (`.pane__head`) is a plain static `<div>` — an
  uppercase label plus a right-aligned monospace count, no chevron and no
  collapse. With only two panes a collapse control earned nothing wide and was
  hazardous narrow (a pane folded wide would be unopenable once its head hides),
  so the pane is a plain `<div class="pane__inner">` and the head is
  `display: none` below 40rem.
- **A `<details>` element now appears nowhere in this surface.** Both former
  disclosures are gone: the artifacts pane is a static head, and the metadata
  block is this button-plus-panel. The surviving chevron rides a button, not a
  native marker.

### Artifact Row (signature)
- **Structure:** a full-width `<button>` with a 2px transparent left border, a
  13px title, and a meta line (kind label · relative time · optional status pill
  · optional change flag).
- **States:** hover `--canvas-hover`, active `--canvas-active`. Selected
  (`aria-current="true"`, now the only `aria-current` state in the panel) →
  `--accent-subtle` fill, `--accent` left border, bold title. **Changed** rows
  carry a persistent `--accent` dot (`.item__flag`) that
  survives until opened, and play a one-shot `settle` fade from `--accent-subtle`
  on the refresh that introduced them.

### Status Line (signature)
- A single polite live region (`role="status"`, `aria-live="polite"`) with a
  leading dot whose color is the tone: resting `--border-strong`, `busy`
  `--accent` (pulsing), `success`, `warning` (`--attention`), `error`
  (`--danger`, with the text turning danger too). Its standing message is the
  change ledger ("12 artifacts tracked · 2 updated"); momentary results flash for
  5 seconds, then it returns to the ledger. It never claims a movement that did
  not happen.

### Loading & Empty States
- **Skeleton:** three rows of two `--border`-filled bars, `shimmer`-animated, at
  staggered widths — shown only before the first list load.
- **Empty blocks:** a bold title plus a plain-language explanation; the
  "no artifacts yet" state lists the six `.copilot-tracking/` roots it reads so
  the visitor learns where files come from. Empty states teach, they don't just
  apologize.

## Do's and Don'ts

### Do:
- **Do** build every mark from a system font stack, a color, CSS geometry, or an
  inline authored `<svg>`. Chevrons, dots, and keycaps are borders and radii; the
  one icon is an inline SVG element — the CSP forbids *fetched* images, icon fonts,
  web fonts, `data:` URLs, and remote assets, not markup you author in the document.
- **Do** reserve `--accent` for selection, focus, and change. Restraint is what
  makes the change ledger readable.
- **Do** stroke interactive controls with `--border-strong` and dividers with
  `--border`, so controls clear 3:1 against their own fill.
- **Do** set every machine-emitted value (path, hash, size, time, slug, count,
  source) in `--font-mono`, and keep human prose in `--font-ui`.
- **Do** ship both themes: define new colors in the `:root` block and the
  `prefers-color-scheme: dark` block together, and keep `color-scheme: light
  dark`.
- **Do** keep motion disarmable: every animation and transition collapses under
  the `prefers-reduced-motion: reduce` media query, and the status line stays
  honest — it never claims a movement that did not happen.
- **Do** preserve the accessibility contract: skip link, semantic landmarks, the
  polite live region, visible `:focus-visible` rings (with the `-2px` inset on
  full-bleed rows), and focus restoration across list rebuilds.

### Don't:
- **Don't** add a shadow, blur, or lift. Convey depth with the canvas tone ramp
  and hairline borders only.
- **Don't** color artifact category. Kind is a weighted `--fg` label; a colored
  chip would read as status on a Primer surface.
- **Don't** spend the state hues (success / attention / severe / danger / done)
  on chrome — they belong to the status line.
- **Don't** put an `xmlns` or a `style` attribute on inline SVG. The parser
  assigns the SVG namespace, and a literal `xmlns="http://..."` adds an `http://`
  string the test suite forbids; inline `style` is blocked by `style-src 'self'`.
  Use presentation attributes (`fill`, `stroke`, `stroke-width`,
  `stroke-linecap`) and `currentColor` instead.
- **Don't** fetch a mark: no images, icon fonts, web fonts, `data:` URLs, remote
  assets, or inline `<style>`/`<script>`. Author it in the document or draw it in
  CSS.
- **Don't** introduce a second accent, a brand color, or a decorative gradient.
- **Don't** drop below `0.75rem` (12px) for any text.
- **Don't** break the source invariant: `pre#source` holds exactly one text
  node assigned via `textContent`. No gutter, no highlighting, no markup — the
  inert-source guarantee and the test suite depend on it.
- **Don't** narrow the reading measure by centering the source column; hold it
  from the right edge with `max(1rem, calc(100% - 82ch))`.
- **Don't** change the `60rem` / `40rem` breakpoints or the `82ch` measure
  casually — several are asserted by `tests/canvas-server.test.mjs` and are
  contractual, not stylistic.
