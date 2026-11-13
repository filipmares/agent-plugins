# Changelog

All notable changes to the agent-plugins marketplace will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and plugin versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — Notes startup performance
- The Notes panel now loads a small ES module shell (about 44 KB, down from 649 KB). The rich editor is a separate bundle, `vendor/notes-editor.js`, imported lazily. The note list renders without waiting for the editor; the editor pane shows a loading state until it is ready, then opens the note. If the editor bundle fails to load, the note opens as plain Markdown.
- Startup fetches the panel state, notes and folders in parallel. List rendering reuses date formatters, computes "today" once per render, groups rows in one pass, and lets the browser skip off-screen rows (`content-visibility`).
- Added `bun run bench:notes`, which measures time to list and editor paint in headless Edge or Chrome against a synthetic library. With 500 notes at 4× CPU throttling, back-to-back medians improved: first paint from about 460 ms to 200 ms, the note list from about 2.5 s to 1.6 s, and an editable restored note from about 4.4 s to 2.8 s. Without throttling, startup is bound by the server and roughly unchanged. The remaining startup time is mostly the library's note scan behind `api/notes`.
- Bumped the plugin and marketplace manifests to `2.2.7`.

### Fixed — Notes stuck on loading without a session
- Opening the Notes canvas no longer waits for the library's first scan before the panel can open. Previously the panel could stay on "loading" with no way to recover if the scan stalled or failed, most visibly when opened without a session.
- The list shows **Loading notes…** while it loads. Reads that wait more than 15 seconds for the library, or fail, show the error in the list with **Try again**.
- The note a panel was asked to open, and unsaved text recovered from a previous close, are claimed only after the list loads (`POST /api/startup`); `GET /api/state` no longer consumes them. Closing or reloading a panel that could not finish loading keeps both for the next try, and any later successful load, not just **Try again**, finishes startup, including after a claim that failed. If the note behind recovered text cannot be read, the text is kept for the next load rather than saved as a copy; it opens as a new draft only when the note is gone or the server cannot keep it. If the user has already moved on, the panel holds it and hands it back on the next list load or when it closes; resending the same recovered text keeps one copy. Saves still wait for the library and are never retried automatically.
- A remembered note the library cannot read yet stays selected instead of being forgotten, and opens on the next list load that succeeds.

### Added — Notes frontmatter viewing
- A read-only row of property pills sits below each note's opening heading (above the text in Markdown view) and shows Agent/Human authorship, origin project, and the original session name. More stays beside the pills at every width and reveals pin status, custom properties, dates, and technical details; long names expand with mouse, touch, or keyboard. Frontmatter editing is not included, and existing pin actions are unchanged.
- The last-edited date line above the note moves into More's dates.
- Bumped the plugin and marketplace manifests to `2.2.6`.

### Added — Notes save-state icon
- Added a save-state icon in the editor action toolbar, with readable status details, a persistent save-failure explanation, and Retry save. Conflicts and Markdown fidelity warnings retain their separate resolution paths.
- Moved Ask Copilot feedback below the toolbar to keep action buttons available in narrow layouts; save errors and recovery are announced without narrating routine autosaves.
- Clearing a failed new draft no longer announces that its changes were saved when no note file exists.
- Bumped the plugin and marketplace manifests to `2.2.5`.

### Added — Notes first-use guidance
- Empty libraries and folders now offer a short invitation and Create note action; empty smart views and searches have contextual guidance.
- A compact Formatting help link below the rich editor opens supported input and keyboard shortcuts without a permanent formatting toolbar.
- Empty note lists drop listbox semantics and their tab stop, keeping actions accessible and the result count announced.
- Bumped the plugin and marketplace manifests to `2.2.4`.

### Fixed — Notes drawer focus
- Keep focus in the Notes drawer while it is open and restore it to the trigger when closed, including after sidebar resizing.
- Bumped the plugin and marketplace manifests to `2.2.3` for the Notes scrolling and drawer-focus fixes.

### Added — Notes in-context screenshots
- The Notes guide now opens its Screenshots section with four scenes that show the panel beside a chat: the agent saving a decision, Ask Copilot, recalling a decision from another session, and the expanded project view. The three panel-only screenshots remain under "The panel on its own".
- Notes stays docked in one continuous app frame, with faded surrounding context and reconstructed composer controls matching the product reference.
- The fictional Shiplog story now uses Azure Static Web Apps, Azure SQL, Microsoft Entra ID, Azure Monitor and Azure Boards, with deadpan prototype-to-production easter eggs.
- These are illustrations, not captures of the native app. The window frame, sessions sidebar and chat are a mock-up around the real panel running in headless Microsoft Edge on Windows, with synthetic notes in a disposable library, the panel's standalone light/dark fallback colors, and a mocked send callback. No real notes, sessions or chat turns appear. Docs and image assets only; no code or manifest version change.

### Fixed — Notes scrolling
- Keep the Notes panel's grid row within its available height so the folder list, note list, and editor scroll inside their panes instead of expanding the panel; background refreshes preserve list scroll and focus.

### Fixed — Notes without a session
- The Notes canvas now opens and saves notes when the Copilot app opens it without a session. It previously refused with "Cannot read this session's workspace.yaml; no provenance was guessed", because the app runs a sessionless canvas under a stand-in session that has no `workspace.yaml` in the Copilot home.
- Notes written from a sessionless panel carry no session origin: no `session_id` or `session_name`, and edits do not add to `sessions`. The stand-in session is never recorded. Only an absent `workspace.yaml` counts as no session; unreadable, oversized, malformed or mismatched session metadata is still refused.
- The panel hides This Session and Ask Copilot when there is no session. The `notes_manage` agent tool is unchanged and still requires its session's provenance.
- Bumped the plugin and marketplace manifests to `2.2.2`.

### Fixed — bundled canvas discovery
- Register the parent `extensions/` discovery directory instead of individual extension folders so Copilot discovers both Notes and RPI Artifact Navigator through the existing `agent-plugins` plugin. No separate plugin, manual import, or Agent Plugins format migration is required.
- Match plugin validation to Copilot's immediate-subdirectory discovery and add regression tests for bundled canvases, incorrect leaf paths, duplicate canvas ids, and missing entry points.
- Bumped the plugin and marketplace manifests to `2.2.1`.

### Added — Notes canvas
- New `extensions/notes` canvas extension: global Markdown notes for the Copilot app, stored as plain `.md` files in the OS Documents `Copilot Notes` folder. Each note's YAML frontmatter records a stable id, timestamps, and the creating session, project and branch; custom fields are preserved and origin fields never change.
- Apple Notes-style panel (folders, grouped note list, editor) with smart views, search across every folder, pinning, drag-to-folder, keyboard navigation, and colors that follow the Copilot app's light/dark theme. The rich editor is a non-React port of [bholmesdev/hubble.md](https://github.com/bholmesdev/hubble.md) (MIT) with a plain Markdown view; notes the rich editor cannot round-trip exactly open as plain Markdown. **Copilot** saves the note and queues a prompt with it attached to the owning session.
- The `notes_manage` tool lets agents create, search, read, append to, update, move and delete notes and list folders. Every write is version-checked and serialized across processes, deletion goes to the OS trash, and edits made elsewhere reload live. A stale save shows a Reload / Keep Mine choice, and text left unsaved when the panel closes is recovered instead of overwriting a newer note.
- On Windows, selected filesystem mutations retry transient `EPERM`, `EACCES` or `EBUSY` for about 1.3 seconds; retried note replacements and deletions re-check the content version on every attempt. Recovered drafts are claimed with an exclusive marker so two panels cannot restore the same draft. See the Notes guide for retry scope and best-effort recovery exceptions.
- Registered `extensions/notes` in the plugin manifest and bumped the plugin and marketplace manifests to `2.2.0`. Deferred features are tracked in [#60](https://github.com/filipmares/agent-plugins/issues/60).

### Added — RPI Artifact Navigator plugin distribution
- The `agent-plugins` plugin manifest now declares `extensions: ["extensions/rpi-artifact-navigator"]`, so installing the plugin installs the canvas and `copilot plugin update agent-plugins` delivers canvas updates. Previously the canvas was reachable only through a manual **Import canvas from repo** copy, which had no update channel — a plugin version bump did not reach it. Unlike the removed `hve-core-canvas` package, this needs no second plugin and no `../../extensions` symlink, because the repo root is already the plugin source.
- Bumped the plugin and marketplace manifests to `2.1.0`.

### Added — RPI Artifact Navigator targeting
- Added self-contained RPI artifact change detection, automatic task-scoped opening, per-instance refresh isolation, and active-artifact selection without requiring HVE Core changes.

### Added — Copilot Code Review agent
- Added the user-invocable, evidence-based `Copilot Code Review` agent and its Copilot plugin manifest and documentation wiring; it reviews supplied changes without implementing fixes.

### Removed — hve-core-canvas CLI plugin
- Removed the redundant CLI plugin package and marketplace entry. The RPI Artifact Navigator is distributed only as a standalone GitHub Copilot app canvas extension under `extensions/rpi-artifact-navigator/`.

### Added — Copilot plugin validation
- `scripts/validate-copilot-plugin.ts` plus `bun run validate:copilot-plugin` validate marketplace and plugin manifest parity, source and extension path containment, required `extension.mjs` entry points, canvas id and action name uniqueness, and the reserved `canvas.` action prefix. Canvas extraction is limited to a documented, statically provable syntactic subset — string literals or module-level immutable string constants — and reports anything it cannot prove as an error instead of skipping it.
- `bun run test:canvas` runs the standalone canvas extension's test suite. Existing `bun run validate` and `bun run list` are unchanged.

### Added — agent-merge v1.0.0
- New skill: scope discipline for unattended pull-request review rounds. A review comment is an input, not a mandate — the skill gives an ordered test for deciding whether a suggestion belongs in the PR, and a closed four-token vocabulary (`fixed`, `deferred`, `tracked`, `inapplicable`) for recording each decision as a hidden HTML-comment marker on the thread reply.
- `scripts/agent-merge-stats.mjs` (Node 18+, stdlib only, needs an authenticated `gh`) reads those markers back across every PR in a repo so the decisions can be audited on evidence: `--deferred` lists the suggestions the rule turned away with links for bulk triage, `--malformed` lists markers outside the vocabulary alongside the token each should have been. Read-only; with no `--repo` it censuses whichever repository the working directory belongs to.

### Added — Copilot CLI plugin marketplace
- Added `.github/plugin/marketplace.json` and `.github/plugin/plugin.json` so `copilot plugin marketplace add filipmares/agent-plugins` works again. The repo root is the plugin source, and all four skills under `skills/` install as one `agent-plugins` plugin.

### Added — copilot-migrate v1.0.0
- New skill: move a GitHub Copilot app installation between machines, including across operating systems.
- `scripts/copilot_migrate.py` (Python 3.9+, stdlib only) exports settings, skills, MCP config, tool permissions, canvas extension artifacts and databases into one bundle, and rewrites the absolute filesystem paths Copilot stores in SQLite and `permissions-config.json` so projects still resolve after the move.
- Migrated in from the standalone `filipmares/copilot-migrate` repository, which is now retired.

### Changed — repository restructure
- **BREAKING**: switched distribution from a Claude Code plugin marketplace (`marketplace.json`, `.claude-plugin/plugin.json`) to [skills.sh](https://skills.sh)-only. Install via `npx skills add filipmares/agent-plugins`.
- Flattened `plugins/<plugin>/skills/<skill>/` to `skills/<skill>/` at the repo root.
- Renamed each skill's frontmatter `name` to its globally unique form (`cli-skill-generator`, `plugin-analyzer`, `consensus-planner`) and added `license` / `metadata.author` / `metadata.version`.
- Replaced `.templates/plugin-template/` with `.templates/skill-template/`.
- Replaced `scripts/validate-plugin.ts` and `scripts/list-plugins.ts` with `validate-skill.ts` and `list-skills.ts`.
- Rewrote `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, and `scripts/README.md` for the skills.sh workflow.

### Changed — consensus-planner v1.3.0
- Multi-select model picker replaces iterative single-select loop in Step 2 ([#36](https://github.com/filipmares/agent-plugins/pull/36))

### Fixed
- Add `version` field to all plugin entries in `marketplace.json` so marketplace installs correctly record plugin versions ([#35](https://github.com/filipmares/agent-plugins/pull/35))

## 2026-02-11

### Added — consensus-planner v1.2.0
- Dedicated synthesis prompt template for Step 5 ([#33](https://github.com/filipmares/agent-plugins/pull/33))
- Disagreement ledger to feedback prompt for structured convergence ([#32](https://github.com/filipmares/agent-plugins/pull/32))
- Output structure validation with single retry after plan collection ([#31](https://github.com/filipmares/agent-plugins/pull/31))
- Single retry for failed agents in Steps 3 and 4 ([#30](https://github.com/filipmares/agent-plugins/pull/30))
- Explicit Assumptions section to planning prompt ([#28](https://github.com/filipmares/agent-plugins/pull/28))
- Fixed-format complexity and file count fields to planning prompt ([#27](https://github.com/filipmares/agent-plugins/pull/27))
- Context exclusion patterns to Step 1d glob ([#26](https://github.com/filipmares/agent-plugins/pull/26))

### Fixed — consensus-planner
- Multi-select model selection UX with iterative `ask_user` loop ([#29](https://github.com/filipmares/agent-plugins/pull/29))

### Added — consensus-planner v1.0.0
- Multi-model iterative consensus planning plugin ([#17](https://github.com/filipmares/agent-plugins/pull/17))

### Added — plugin-analyzer v1.0.0
- Plugin analyzer with multi-model analysis capabilities ([#16](https://github.com/filipmares/agent-plugins/pull/16))

## 2026-02-09

### Changed — cli-skill-generator v2.0.0
- Improved handling for large CLI tools ([#6](https://github.com/filipmares/agent-plugins/pull/6))

## 2026-02-07

### Added — cli-skill-generator v1.0.0
- CLI skill generator plugin for generating Claude Code skills from any CLI tool ([#3](https://github.com/filipmares/agent-plugins/pull/3))

## 2026-02-06

### Added
- Initial marketplace structure with validation scripts and documentation ([#1](https://github.com/filipmares/agent-plugins/pull/1))
