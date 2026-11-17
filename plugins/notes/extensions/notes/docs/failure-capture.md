# Notes failure capture

## Goal

Capture runtime failures from Notes in a bounded, local-only journal that users can review and explicitly copy for debugging or a GitHub issue. Automatic reporting and issue posting are out of scope.

## Design

- Capture is always on and local. Nothing is transmitted automatically; data leaves the device only when a user explicitly includes the generated issue block.
- A per-user journal spans Notes runs but contains no workspace or session identity. Keep at most 30 days and 1 MiB, evicting the oldest records.
- Store structured, OTel-aligned JSONL (timestamp, severity, event name, attributes, and optional operation/trace identifiers); use no OTel SDK, exporter, or service integration.
- Render a human-reviewable issue block, newest incidents first, capped at 20 KiB. Show it in the Notes **View diagnostics** preview and expose the same report through the read-only `notes_diagnostics` Copilot tool.
- The preview stays local. When called, `notes_diagnostics` returns the report to the Copilot conversation for debugging; neither path files or sends a GitHub issue automatically.
- Use a strict safe-field allowlist. Never persist note content, titles, filenames, prompts, search queries, session/project names, capability URLs, arbitrary exception messages, user/home paths, or persistent identifiers.
- Snapshot only safe environment metadata with each failure: Notes/plugin version, Copilot app and SDK versions when available, Node version, OS name/version, and architecture. Use `unknown` when unavailable. Include only whether the panel opened standalone or in a session; never persist session identity.
- Capture unexpected failures, degraded operation, and data-integrity risks. Omit expected outcomes such as conflicts, validation errors, not-found, and cancelled deletes.
- Capture Notes-owned browser/provider failures and host failures explicitly attributable to Notes work, not general Copilot session errors. Include explicit boundary failures and otherwise-unhandled browser `error`/`unhandledrejection` events.
- Record only explicit structured events; do not scrape free-form `session.log` output or console/error text.
- Retain only Notes-extension repo-relative backend stack frames with line/column. Browser frames keep sanitized bundle-relative function/line/column only; do not ship source maps.
- Capture a panel that never finishes loading from both sides, because its own page may be unable to report. 30 seconds after the panel's server starts, if the page has not claimed startup (`POST /api/startup`), the provider records `notes.panel.startup_stalled` with the last stage it saw: `page_not_requested`, `script_not_requested`, `api_not_reached` or `startup_incomplete`. 30 seconds after the script runs, the page records `notes.browser.startup_stalled` with the step it is waiting on: `state_pending`, `lists_pending` or `startup_claim_pending`. A slow library first shows up as `library_busy` (15 seconds).
- Persist a private, per-panel startup marker when the provider creates its server. Remove it when the page claims startup, a stall is recorded, the panel closes, or server creation fails. On the next extension launch, markers owned by dead local processes become `notes.panel.startup_abandoned`, covering an extension process killed before the 30-second watchdog can run.
- Record a request that carries the panel's capability token but fails the Host or Origin check as `notes.request.rejected` (`host_mismatch`, `origin_null`, `origin_mismatch`, `origin_missing`), once per reason per panel. Never record the header values. Requests without the token are not recorded, so probes and stray fetches cannot fill the journal; the 404 response is unchanged.
- Record a shadow index failure once per process as degraded operation, `notes.index.degraded` (`index_unavailable`, `index_busy`, `index_corrupt`, or an allowlisted system code), then stop updating the index. This includes unavailable SQLite/workers, unexpected worker errors/exits, exhausted 30-second busy retries, and forced termination after a 30-second worker shutdown grace period. Unstable file reads retry for up to 30 seconds; exhausting those retries also degrades the index. Worker failures cross the thread boundary as a code and stack, never a note snapshot; the same journal stack sanitization applies. Note operations continue from the files and never wait for index work. Abrupt process termination is not itself journaled as an index failure; the next launch rereads the files to catch up.
- Known limits: a panel kept hidden in the background may never request its page and is recorded as `page_not_requested`. An abrupt process kill is recorded on the next Notes extension launch, not immediately. Failures before the extension module loads, or in the host's canvas and webview layers (including control-runtime startup timeouts), are not captured by Notes; Copilot app diagnostics are required for those. If the host does not provide its app version in the extension environment, it is shown as `unknown`.
- Deduplicate by deterministic fingerprint from safe event/error fields and normalized top stack frames. Include occurrence count and first/last-seen timestamps.
- Keep an in-memory ring of about 20 recent operation outcomes (operation, result code, duration, operation ID; no arguments/content) and snapshot it only with a failure. Browser entries identify API route/status, not UI clicks.
- Use random per-operation correlation IDs to join browser and provider records without persistent user/session identity.
- If persistence fails, emit one minimal sanitized warning through the local extension logger; do not log the raw exception or retry recursively.
- Test privacy by injecting sentinel note text, filenames, home paths, tokens, and exception messages and asserting none appear in the journal or rendered bundle. Test capture, deduplication, and retention bounds as well.

