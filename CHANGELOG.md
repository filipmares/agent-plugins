# Changelog

Repository-wide and cross-plugin changes are documented here. Cross-cutting plugin changes also appear in each affected plugin changelog.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and plugin versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — Notes background index synchronization
- Move SQLite discovery, writes and busy waits to a coalescing worker, synchronized after mutations and watcher changes without blocking file-backed requests. Ordered generations reject stale cross-session commits without locking during discovery; unstable reads retry, worker failures degrade safely, and shutdown drains watcher work with a bounded worker grace period.
- Keep list/search/read behavior, frontmatter adoption and the 15-second deadlines unchanged; this does not fix the 10k-note cold-start issue (#84).
- Bumped the standalone Notes plugin and its marketplace entry to `1.0.1`.
- Bumped the developer plugin and marketplace metadata to `4.0.1` for the requested marketplace release.

### Changed — Standalone Notes plugin
- Moved Notes, its tools, offline bundles, and licences into `plugins/notes/`, available separately as `notes@agent-plugins` at version `1.0.0`.
- Removed bundled Notes from `agent-plugins` and bumped that plugin and marketplace metadata to `4.0.0`. Existing users must update `agent-plugins` before installing `notes`, then reopen Notes in a new session; notes, UI state, and recovered drafts stay in place.
- Updated developer commands, installation guides, packaging regressions, and per-plugin release checks so Notes can update independently. Removing a plugin from the marketplace now requires a marketplace release.

### Fixed — bundled canvas discovery
- Register the parent `extensions/` discovery directory instead of individual extension folders so Copilot discovers both Notes and RPI Artifact Navigator through the existing `agent-plugins` plugin. No separate plugin, manual import, or Agent Plugins format migration is required.
- Match plugin validation to Copilot's immediate-subdirectory discovery and add regression tests for bundled canvases, incorrect leaf paths, duplicate canvas ids, and missing entry points.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.1`.

### Removed — hve-core-canvas CLI plugin
- Removed the redundant CLI plugin package and marketplace entry. The RPI Artifact Navigator is distributed only as a standalone GitHub Copilot app canvas extension under `extensions/rpi-artifact-navigator/`.

### Added — Copilot plugin validation
- `scripts/validate-copilot-plugin.ts` plus `bun run validate:copilot-plugin` validate marketplace and plugin manifest parity, source and extension path containment, required `extension.mjs` entry points, canvas id and action name uniqueness, and the reserved `canvas.` action prefix. Canvas extraction is limited to a documented, statically provable syntactic subset — string literals or module-level immutable string constants — and reports anything it cannot prove as an error instead of skipping it.
- `bun run test:canvas` runs the standalone canvas extension's test suite. Existing `bun run validate` and `bun run list` are unchanged.

### Added — Copilot CLI plugin marketplace
- Added `.github/plugin/marketplace.json` and `.github/plugin/plugin.json` so `copilot plugin marketplace add filipmares/agent-plugins` works again. The repo root is the plugin source, and all skills under `skills/` install as one `agent-plugins` plugin.

### Changed — repository restructure
- **BREAKING**: switched distribution from a Claude Code plugin marketplace (`marketplace.json`, `.claude-plugin/plugin.json`) to [skills.sh](https://skills.sh)-only. Install via `npx skills add filipmares/agent-plugins`.
- Flattened `plugins/<plugin>/skills/<skill>/` to `skills/<skill>/` at the repo root.
- Updated skill frontmatter with globally unique names and added `license` / `metadata.author` / `metadata.version`.
- Replaced `.templates/plugin-template/` with `.templates/skill-template/`.
- Replaced `scripts/validate-plugin.ts` and `scripts/list-plugins.ts` with `validate-skill.ts` and `list-skills.ts`.
- Rewrote `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, and `scripts/README.md` for the skills.sh workflow.

### Fixed
- Add `version` field to all plugin entries in `marketplace.json` so marketplace installs correctly record plugin versions ([#35](https://github.com/filipmares/agent-plugins/pull/35))

## 2026-02-06

### Added
- Initial marketplace structure with validation scripts and documentation ([#1](https://github.com/filipmares/agent-plugins/pull/1))
