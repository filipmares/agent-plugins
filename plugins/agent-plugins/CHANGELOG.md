# Changelog

All notable changes to the `agent-plugins` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and plugin versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — Standalone Notes plugin
- Moved Notes, its tools, offline bundles, and licences into `plugins/notes/`, available separately as `notes@agent-plugins` at version `1.0.0`.
- Removed bundled Notes from `agent-plugins` and bumped that plugin and marketplace metadata to `4.0.0`. Existing users must update `agent-plugins` before installing `notes`, then reopen Notes in a new session; notes, UI state, and recovered drafts stay in place.
- Updated developer commands, installation guides, packaging regressions, and per-plugin release checks so Notes can update independently. Removing a plugin from the marketplace now requires a marketplace release.

### Changed — plugin distribution
- The plugin now bundles three skills; bumped the plugin and marketplace manifests to `3.0.0`.

### Fixed — bundled canvas discovery
- Register the parent `extensions/` discovery directory instead of individual extension folders so Copilot discovers both Notes and RPI Artifact Navigator through the existing `agent-plugins` plugin. No separate plugin, manual import, or Agent Plugins format migration is required.
- Match plugin validation to Copilot's immediate-subdirectory discovery and add regression tests for bundled canvases, incorrect leaf paths, duplicate canvas ids, and missing entry points.
- Bumped the `agent-plugins` and marketplace manifests to `2.2.1`.

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
- Added `.github/plugin/marketplace.json` and `.github/plugin/plugin.json` so `copilot plugin marketplace add filipmares/agent-plugins` works again. The repo root is the plugin source, and all skills under `skills/` install as one `agent-plugins` plugin.

### Added — copilot-migrate v1.0.0
- New skill: move a GitHub Copilot app installation between machines, including across operating systems.
- `scripts/copilot_migrate.py` (Python 3.9+, stdlib only) exports settings, skills, MCP config, tool permissions, canvas extension artifacts and databases into one bundle, and rewrites the absolute filesystem paths Copilot stores in SQLite and `permissions-config.json` so projects still resolve after the move.
- Migrated in from the standalone `filipmares/copilot-migrate` repository, which is now retired.

### Changed — repository restructure
- **BREAKING**: switched distribution from a Claude Code plugin marketplace (`marketplace.json`, `.claude-plugin/plugin.json`) to [skills.sh](https://skills.sh)-only. Install via `npx skills add filipmares/agent-plugins`.
- Flattened `plugins/<plugin>/skills/<skill>/` to `skills/<skill>/` at the repo root.
- Updated skill frontmatter with globally unique names and added `license` / `metadata.author` / `metadata.version`.
- Replaced `.templates/plugin-template/` with `.templates/skill-template/`.
- Replaced `scripts/validate-plugin.ts` and `scripts/list-plugins.ts` with `validate-skill.ts` and `list-skills.ts`.
- Rewrote `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, and `scripts/README.md` for the skills.sh workflow.

### Fixed
- Add `version` field to all plugin entries in `marketplace.json` so marketplace installs correctly record plugin versions ([#35](https://github.com/filipmares/agent-plugins/pull/35))

## Skill release history

### 2026-02-09 — cli-skill-generator v2.0.0
- Improved handling for large CLI tools ([#6](https://github.com/filipmares/agent-plugins/pull/6))

### 2026-02-07 — cli-skill-generator v1.0.0
- CLI skill generator plugin for generating Claude Code skills from any CLI tool ([#3](https://github.com/filipmares/agent-plugins/pull/3))

## Marketplace history

### 2026-02-06 — Initial marketplace structure
- Initial marketplace structure with validation scripts and documentation ([#1](https://github.com/filipmares/agent-plugins/pull/1))
