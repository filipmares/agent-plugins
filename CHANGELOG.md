# Changelog

All notable changes to the agent-plugins marketplace will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and plugin versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Copilot Code Review agent
- Added the user-invocable, evidence-based `Copilot Code Review` agent and its Copilot plugin manifest and documentation wiring; it reviews supplied changes without implementing fixes.

### Added — hve-core-canvas v0.1.0 (experimental, opt-in)
- New companion plugin under `plugins/hve-core-canvas/`, installed separately with `copilot plugin install hve-core-canvas@agent-plugins`. It is **not** part of the `agent-plugins` skills plugin and does not change the skills.sh distribution.
- Adds one read-only Copilot canvas, **RPI Artifact Navigator**, that browses HVE-Core RPI tracking Markdown: an artifact index with type/date/task/status, a heading outline, and the artifact's exact source rendered as inert text. Files on disk stay authoritative; panel state is transient.
- Exposes exactly three read-only agent actions returning raw JSON values: `list_rpi_artifacts` → `{ artifacts, count }`, `get_rpi_artifact` → `{ artifact }`, and `refresh_rpi_artifacts` → `{ artifacts, count, refreshedInstances }`.
- Reads are restricted to `.copilot-tracking/{research,plans,details,changes,reviews/plans,reviews/logs}`. Absolute paths, `..` traversal, sibling-prefix confusion, symlinked path segments, multiply-linked files, and non-regular files such as FIFOs are rejected. Each read is bound to a verified file descriptor, and containment is re-established after the open against the fully resolved real path, so an intermediate directory substituted mid-read is rejected rather than followed.
- The renderer is served per instance from `127.0.0.1` behind an unguessable 256-bit path capability, with `Host`/`Origin` enforcement, CORS denial, a `default-src 'none'` Content-Security-Policy that forbids inline script and style, `no-store` caching, and capability invalidation on close. No outbound network calls, no command execution, no dependencies, and no telemetry.
- Explicit limits: 200 artifacts, 1 MiB per file, 500 headings per file, and 1.5 MiB per serialized response. An artifact that exceeds a limit fails the listing with a closed error code rather than being silently omitted from an index that presents itself as complete.
- The heading outline follows CommonMark fence rules, tracking fence character and length so a shorter run cannot close a longer block. Outline navigation uses the parser's own heading source offsets and scrolls to the heading's rendered position, so the panel and the agent always agree on what a document contains.
- Supported configuration for this pilot is macOS with GitHub Copilot CLI 1.0.80 and VoiceOver, in light and dark themes. All other operating systems, hosts, versions, browsers, and assistive technologies are untested and unsupported.
- Promotion into the main HVE-Core plugin is explicitly out of scope until separate success and stability gates are agreed.

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
