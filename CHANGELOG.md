# Changelog

All notable changes to the agent-plugins marketplace will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and plugin versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
