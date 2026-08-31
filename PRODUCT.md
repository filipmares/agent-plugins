# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Software engineers who drive AI coding agents (GitHub Copilot CLI and the
GitHub Copilot app, Claude Code, Cursor, Aider) and who install reusable
procedural knowledge into those agents. Their situation is a working repository
and a running agent session; their job is to make the agent behave
predictably on a real task rather than to read documentation.

A second, narrower audience uses the RPI Artifact Navigator canvas: the same
engineer, mid-session, supervising an agent that is executing a Research →
Plan → Implement → Review loop. That person is not authoring; they are
checking what the agent has written, where it is in the loop, and whether the
plan still matches the work.

## Product Purpose

`agent-plugins` is a collection of agent skills distributed two ways: through
the [skills.sh](https://skills.sh) ecosystem and as a GitHub Copilot CLI plugin
marketplace. Each skill is packaged instructions plus optional supporting files
that an agent loads on demand. The repository also ships one optional canvas
extension. Success is an agent that performs a specialized task correctly
without the user re-explaining the procedure.

## Positioning

Skills here are self-contained and validated: a skill never references files
outside its own directory, names are globally unique because skills.sh installs
into a shared directory, and `scripts/validate-skill.ts` enforces the contract.
The RPI Artifact Navigator is the only piece with a UI, and its distinguishing
mechanism is that it is a *read-only projection of files on disk*, opened and
refreshed automatically by the agent's own tool calls, with the filesystem
remaining the single source of truth.

## Operating Context

- Skills live in `skills/<name>/SKILL.md`; the repo root is the Copilot plugin
  source, with `.github/plugin/` holding `marketplace.json` and `plugin.json`.
- Bun + TypeScript scripts, no build step. `bun run scripts/validate-skill.ts`,
  `bun run scripts/list-skills.ts`, `bun test extensions/rpi-artifact-navigator/tests/*.test.mjs`.
- The RPI workflow writes Markdown tracking artifacts under `.copilot-tracking/`
  in six roots: `research`, `plans`, `details`, `changes`, `reviews/plans`,
  `reviews/logs`. Filenames carry a `YYYY-MM-DD` directory segment and a task
  slug; the artifact kind is a filename suffix (`-research`, `-plan`,
  `-phase-details`, `-changes`, `-plan-critique`, `-review`).
- The navigator canvas is imported per-user in the GitHub Copilot app
  (**Customize → Extensions → Import canvas from repo**). It is experimental and
  verified only on macOS. It is not activated by opening the repository.

## Capabilities and Constraints

RPI Artifact Navigator:

- Read-only. It never writes, executes, or reaches the network. Reopening or
  reloading always rehydrates from disk.
- Three agent-callable actions: `list_rpi_artifacts`, `get_rpi_artifact`,
  `refresh_rpi_artifacts`. Pre/post tool hooks detect artifact changes, open a
  task-scoped panel for a new artifact, and refresh an open panel without
  stealing focus. Closing a panel suppresses edit-driven reopening for that task
  until a new artifact appears.
- Data available per artifact: workspace-relative id (path), kind, date, task
  slug, title (first H1), status (parsed from `Status` / `Planning status` /
  `Execution status` bullets, outside code fences), last-modified time, size in
  bytes, SHA-256, the full ATX heading outline with level and source line, and
  the exact source text. Unknown metadata is reported as `null`, never invented.
- Markdown is never converted to HTML. Source text is displayed as inert text.
- Hard ceilings that fail explicitly rather than truncate: 200 artifacts,
  1 MiB per file, 500 headings, 1.5 MiB response.
- Served over a loopback HTTP server bound to `127.0.0.1` on an ephemeral port,
  namespaced by an unguessable per-instance capability path.

**Binding UI constraint:** the served Content-Security-Policy is
`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';
object-src 'none'`. No fetched images, no web fonts, no icon fonts, no remote
assets, no inline script or style, no `data:` URLs. Tests additionally assert
the document contains no `http://` or `https://` string, no inline `<script>` or
`<style>`, and that the client script never touches `innerHTML`, `outerHTML`,
`document.write`, or `eval`. Any visual identity must therefore be produced from
system font stacks, color, CSS, and inline SVG authored directly in the markup.
Inline SVG is permitted because it is a document element rather than a fetched
resource, so `img-src` does not govern it; it must carry no `xmlns` attribute
(which would introduce a forbidden `http://` string) and no `style` attribute
(which `style-src 'self'` blocks).

## Brand Commitments

- The canvas is named **RPI Artifact Navigator**.
- Confirmed by the user: the navigator panel must read as native GitHub Copilot
  app chrome — neutral and unobtrusive — and should sit alongside GitHub Primer
  and github.com/Copilot app surfaces, whose craft level is the bar.
- Confirmed by the user: the redesign may add navigation capabilities that the
  existing data already supports (filter/search, grouping by task and date, copy
  path). It may not invent data.
- Revised by the user after seeing the build: no heading outline. Artifacts are
  read whole, so a parallel outline pane is not worth its width. Headings are
  still parsed and their count is still reported; only the navigator pane is
  gone. Below 40rem the artifact index and the document are two separate views
  with a back control, never two crowded panes on one screen.

## Evidence on Hand

- Real implementation and tests at `extensions/rpi-artifact-navigator/`.
- Real skills at `skills/` (agent-merge, cli-skill-generator, consensus-planner,
  copilot-migrate, plugin-analyzer).
- No usage metrics, adoption numbers, customers, benchmarks, or pricing exist.
  Future work must not fabricate them.

## Product Principles

1. Files on disk are the truth; every surface is a projection that can be
   discarded and rebuilt from them.
2. Fail explicitly rather than quietly truncate or invent. `null` is a valid,
   honest answer.
3. Untrusted content stays inert. Containment is re-verified, not assumed.
4. Self-contained units: a skill or extension carries everything it needs.
5. The tool disappears into the task. The engineer is supervising an agent, not
   using an app.

## Accessibility & Inclusion

The navigator already commits to a keyboard skip link, visible focus rings, a
polite live status region, semantic landmarks, `prefers-reduced-motion`, and
both color schemes via `color-scheme: light dark`. These are contractual — the
test suite asserts them — and future work must preserve them.
