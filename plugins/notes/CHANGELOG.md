# Changelog

All notable changes to the standalone Notes plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and plugin versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-11-17

### Added — Background shadow-index synchronization
- Keep the Notes shadow index synchronized in a background worker; file-backed reads remain unchanged.

## [Unreleased]

### Fixed - Notes list startup synchronization
- Refresh notes and folder counts when the first live connection opens, catching changes missed while the last note was restoring without replacing unsaved edits.
- Bumped the Notes plugin and marketplace entry to `1.0.3`.

### Fixed — Notes title tabs
- Tab inserts a tab in the opening note heading without leaving the editor; Shift+Tab still navigates.
- Bumped the Notes plugin and marketplace entry to `1.0.1`.

## [1.0.0] - 2026-11-16

### Added — Standalone Notes plugin
- Moved Notes, its tools, offline bundles, and licences into `plugins/notes/`, available separately as `notes@agent-plugins` at version `1.0.0`.
- Existing notes, UI state, and recovered drafts stay in place.

## Notes features before the standalone release

The entries below describe Notes features shipped as part of `agent-plugins`. Any plugin-version numbers in these entries refer to `agent-plugins` releases, not Notes releases.

### Added — Notes SQLite shadow index
- Mirror each completed Notes library scan into a rebuildable local SQLite index shared by all sessions. Nothing reads it yet; list, search and reads still use the files. SQLite failures are logged and journaled as `notes.index.degraded` while Notes keeps working.
- A rejecting logger can no longer cause an unhandled rejection when the failure journal cannot save.
- Bumped the `agent-plugins` and marketplace manifests to `3.0.2`.

### Added — Daily Notes benchmark history
- Run the 1,000- and 10,000-note benchmarks daily on Windows, retain results and failures, and publish comparable trends to a Pages dashboard.

### Added — Notes benchmark baseline
- Include the initial application scan in Notes startup measurements, generate parser-validated bulk fixtures, and measure rendered note opening, search, and warm views with repeated-sample p90 and explicit runtime limitations.

### Changed — Frameless Notes editing
- Removed the focus outline from the rich-text note editing surface while keeping focus indicators on toolbar and navigation controls.
- Bumped the `agent-plugins` and marketplace manifests to `3.0.1`.

### Added — Independent Notes titles
- Added an editable toolbar title stored in frontmatter, independent of Markdown headings; moved creator and read-only properties into the toolbar.
- Added responsive toolbar actions and explicit save-state labels.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.13`.

### Changed — Notes settings access
- Replaced the Folders sidebar's diagnostics text link with a Settings gear and a responsive Settings dialog; diagnostics is now the dialog's Diagnostics section.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.12`.

### Added — Notes canvas icon
- Added an original canvas icon (`extensions/notes/assets/icon.png`, source `icon.svg`): a white spiral notepad on an amber tile, sized to sit with the app's built-in canvas icons.
- The Notes canvas declares it as `icon`. The runtime accepts and resolves the path, but the Copilot app does not yet render extension canvas icons, so this is forward-compatible and has no visible effect today.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.11`.

### Added — Notes diagnostics for users
- Added a preview-and-copy flow in the Notes sidebar and a read-only `notes_diagnostics` tool, both using the same bounded, sanitized local report.
- Clarified that calling `notes_diagnostics` returns the report to the Copilot conversation; nothing is posted to an issue automatically.
- Snapshotted allowlisted app/plugin/SDK/runtime environment versions and standalone-versus-session opening mode per incident; unavailable versions are labeled `unknown`.
- Documented that failures before the Notes extension starts require Copilot app diagnostics.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.10`.

### Fixed — Notes startup failure capture
- Added a private per-panel startup marker so an extension process killed before the 30-second watchdog runs is recorded as `notes.panel.startup_abandoned` on the next Notes launch.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.9`.

### Added — Notes local failure journal
- Added a bounded, local-only diagnostic journal and reviewable issue-block renderer. Capture is structured and allowlisted; note content, exception messages and absolute paths are excluded.
- Added browser-to-provider correlation IDs, failure deduplication, recent operation context, retention and privacy tests.
- A panel that never finishes loading is journaled: the provider records the last stage its page reached (`notes.panel.startup_stalled`), the page records the step it is waiting on (`notes.browser.startup_stalled`), and requests carrying the panel's token that fail the Host or Origin check are recorded once per reason (`notes.request.rejected`), without the header values.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.8`.

### Changed — Notes startup performance
- The Notes panel now loads a small ES module shell (about 44 KB, down from 649 KB). The rich editor is a separate bundle, `vendor/notes-editor.js`, imported lazily. The note list renders without waiting for the editor; the editor pane shows a loading state until it is ready, then opens the note. If the editor bundle fails to load, the note opens as plain Markdown.
- Startup fetches the panel state, notes and folders in parallel. List rendering reuses date formatters, computes "today" once per render, groups rows in one pass, and lets the browser skip off-screen rows (`content-visibility`).
- Added `bun run bench:notes`, which measures time to list and editor paint in headless Edge or Chrome against a synthetic library. With 500 notes at 4× CPU throttling, back-to-back medians improved: first paint from about 460 ms to 200 ms, the note list from about 2.5 s to 1.6 s, and an editable restored note from about 4.4 s to 2.8 s. Without throttling, startup is bound by the server and roughly unchanged. The remaining startup time is mostly the library's note scan behind `api/notes`.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.7`.

### Fixed — Notes stuck on loading without a session
- Opening the Notes canvas no longer waits for the library's first scan before the panel can open. Previously the panel could stay on "loading" with no way to recover if the scan stalled or failed, most visibly when opened without a session.
- The list shows **Loading notes…** while it loads. Reads that wait more than 15 seconds for the library, or fail, show the error in the list with **Try again**.
- The note a panel was asked to open, and unsaved text recovered from a previous close, are claimed only after the list loads (`POST /api/startup`); `GET /api/state` no longer consumes them. Closing or reloading a panel that could not finish loading keeps both for the next try, and any later successful load, not just **Try again**, finishes startup, including after a claim that failed. If the note behind recovered text cannot be read, the text is kept for the next load rather than saved as a copy; it opens as a new draft only when the note is gone or the server cannot keep it. If the user has already moved on, the panel holds it and hands it back on the next list load or when it closes; resending the same recovered text keeps one copy. Saves still wait for the library and are never retried automatically.
- A remembered note the library cannot read yet stays selected instead of being forgotten, and opens on the next list load that succeeds.

### Added — Notes frontmatter viewing
- A read-only row of property pills sits below each note's opening heading (above the text in Markdown view) and shows Agent/Human authorship, origin project, and the original session name. More stays beside the pills at every width and reveals pin status, custom properties, dates, and technical details; long names expand with mouse, touch, or keyboard. Frontmatter editing is not included, and existing pin actions are unchanged.
- The last-edited date line above the note moves into More's dates.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.6`.

### Added — Notes save-state icon
- Added a save-state icon in the editor action toolbar, with readable status details, a persistent save-failure explanation, and Retry save. Conflicts and Markdown fidelity warnings retain their separate resolution paths.
- Moved Ask Copilot feedback below the toolbar to keep action buttons available in narrow layouts; save errors and recovery are announced without narrating routine autosaves.
- Clearing a failed new draft no longer announces that its changes were saved when no note file exists.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.5`.

### Added — Notes first-use guidance
- Empty libraries and folders now offer a short invitation and Create note action; empty smart views and searches have contextual guidance.
- A compact Formatting help link below the rich editor opens supported input and keyboard shortcuts without a permanent formatting toolbar.
- Empty note lists drop listbox semantics and their tab stop, keeping actions accessible and the result count announced.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.4`.

### Fixed — Notes drawer focus
- Keep focus in the Notes drawer while it is open and restore it to the trigger when closed, including after sidebar resizing.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.3` for the Notes scrolling and drawer-focus fixes.

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
- Bumped the `agent-plugins` and marketplace manifests to `2.2.2`.

### Fixed — bundled canvas discovery
- Register the parent `extensions/` discovery directory instead of individual extension folders so Copilot discovers both Notes and RPI Artifact Navigator through the existing `agent-plugins` plugin. No separate plugin, manual import, or Agent Plugins format migration is required.
- Match plugin validation to Copilot's immediate-subdirectory discovery and add regression tests for bundled canvases, incorrect leaf paths, duplicate canvas ids, and missing entry points.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.1`.

### Added — Notes canvas
- New `extensions/notes` canvas extension: global Markdown notes for the Copilot app, stored as plain `.md` files in the OS Documents `Copilot Notes` folder. Each note's YAML frontmatter records a stable id, timestamps, and the creating session, project and branch; custom fields are preserved and origin fields never change.
- Apple Notes-style panel (folders, grouped note list, editor) with smart views, search across every folder, pinning, drag-to-folder, keyboard navigation, and colors that follow the Copilot app's light/dark theme. The rich editor is a non-React port of [bholmesdev/hubble.md](https://github.com/bholmesdev/hubble.md) (MIT) with a plain Markdown view; notes the rich editor cannot round-trip exactly open as plain Markdown. **Copilot** saves the note and queues a prompt with it attached to the owning session.
- The `notes_manage` tool lets agents create, search, read, append to, update, move and delete notes and list folders. Every write is version-checked and serialized across processes, deletion goes to the OS trash, and edits made elsewhere reload live. A stale save shows a Reload / Keep Mine choice, and text left unsaved when the panel closes is recovered instead of overwriting a newer note.
- On Windows, selected filesystem mutations retry transient `EPERM`, `EACCES` or `EBUSY` for about 1.3 seconds; retried note replacements and deletions re-check the content version on every attempt. Recovered drafts are claimed with an exclusive marker so two panels cannot restore the same draft. See the Notes guide for retry scope and best-effort recovery exceptions.
- Registered `extensions/notes` in the `agent-plugins` manifest and bumped the `agent-plugins` and marketplace manifests to `2.2.0`. Deferred features are tracked in [#60](https://github.com/filipmares/agent-plugins/issues/60).

### Added — Copilot plugin validation
- `scripts/validate-copilot-plugin.ts` plus `bun run validate:copilot-plugin` validate marketplace and plugin manifest parity, source and extension path containment, required `extension.mjs` entry points, canvas id and action name uniqueness, and the reserved `canvas.` action prefix. Canvas extraction is limited to a documented, statically provable syntactic subset — string literals or module-level immutable string constants — and reports anything it cannot prove as an error instead of skipping it.
- `bun run test:canvas` runs the standalone canvas extension's test suite. Existing `bun run validate` and `bun run list` are unchanged.
