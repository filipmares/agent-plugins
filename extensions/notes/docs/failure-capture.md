# Notes failure capture

## Goal

Capture runtime failures from Notes in a bounded, local-only journal that users can review and include in a GitHub issue. Automatic reporting, the issue-posting trigger, and user-facing surfacing are out of scope.

## Design

- Capture is always on and local. Nothing is transmitted automatically; data leaves the device only when a user explicitly includes the generated issue block.
- A per-user journal spans Notes runs but contains no workspace or session identity. Keep at most 30 days and 1 MiB, evicting the oldest records.
- Store structured, OTel-aligned JSONL (timestamp, severity, event name, attributes, and optional operation/trace identifiers); use no OTel SDK, exporter, or service integration.
- Render a human-reviewable issue block, newest incidents first, capped at 20 KiB.
- Use a strict safe-field allowlist. Never persist note content, titles, filenames, prompts, search queries, session/project names, capability URLs, arbitrary exception messages, user/home paths, or persistent identifiers.
- Include only safe environment metadata: Notes/plugin version, Copilot app and SDK versions when available, Node version, OS name/version, and architecture.
- Capture unexpected failures, degraded operation, and data-integrity risks. Omit expected outcomes such as conflicts, validation errors, not-found, and cancelled deletes.
- Capture Notes-owned browser/provider failures and host failures explicitly attributable to Notes work, not general Copilot session errors. Include explicit boundary failures and otherwise-unhandled browser `error`/`unhandledrejection` events.
- Record only explicit structured events; do not scrape free-form `session.log` output or console/error text.
- Retain only Notes-extension repo-relative backend stack frames with line/column. Browser frames keep sanitized bundle-relative function/line/column only; do not ship source maps.
- Capture a panel that never finishes loading from both sides, because its own page may be unable to report. 30 seconds after the panel's server starts, if the page has not claimed startup (`POST /api/startup`), the provider records `notes.panel.startup_stalled` with the last stage it saw: `page_not_requested`, `script_not_requested`, `api_not_reached` or `startup_incomplete`. 30 seconds after the script runs, the page records `notes.browser.startup_stalled` with the step it is waiting on: `state_pending`, `lists_pending` or `startup_claim_pending`. A slow library first shows up as `library_busy` (15 seconds).
- Persist a private, per-panel startup marker when the provider creates its server. Remove it when the page claims startup, a stall is recorded, the panel closes, or server creation fails. On the next extension launch, markers owned by dead local processes become `notes.panel.startup_abandoned`, covering an extension process killed before the 30-second watchdog can run.
- Record a request that carries the panel's capability token but fails the Host or Origin check as `notes.request.rejected` (`host_mismatch`, `origin_null`, `origin_mismatch`, `origin_missing`), once per reason per panel. Never record the header values. Requests without the token are not recorded, so probes and stray fetches cannot fill the journal; the 404 response is unchanged.
- Known limits: a panel kept hidden in the background may never request its page and is recorded as `page_not_requested`. An abrupt process kill is recorded on the next Notes extension launch, not immediately. Failures before the extension module loads, or in the host's canvas and webview layers, are not captured.
- Deduplicate by deterministic fingerprint from safe event/error fields and normalized top stack frames. Include occurrence count and first/last-seen timestamps.
- Keep an in-memory ring of about 20 recent operation outcomes (operation, result code, duration, operation ID; no arguments/content) and snapshot it only with a failure. Browser entries identify API route/status, not UI clicks.
- Use random per-operation correlation IDs to join browser and provider records without persistent user/session identity.
- If persistence fails, emit one minimal sanitized warning through the local extension logger; do not log the raw exception or retry recursively.
- Test privacy by injecting sentinel note text, filenames, home paths, tokens, and exception messages and asserting none appear in the journal or rendered bundle. Test capture, deduplication, and retention bounds as well.

