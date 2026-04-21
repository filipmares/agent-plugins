# Agent Skills

A collection of reusable skills for AI coding agents (Claude Code, Cursor, GitHub Copilot, Aider, …), distributed via [skills.sh](https://skills.sh) — the open ecosystem and CLI for AI-agent skills.

Skills are packaged instructions (and optional supporting files) that extend an agent's capabilities. Unlike a code library, a skill is procedural knowledge the agent loads on demand.

## Installation

The only supported installation method is the [skills](https://skills.sh) CLI, which detects which agent you're using and installs each skill in the right place (e.g. `.claude/skills/`, `.cursor/skills/`, …).

Install **all** skills in this repo:

```bash
npx skills add filipmares/agent-plugins
```

Or with pnpm:

```bash
pnpm dlx skills add filipmares/agent-plugins
```

Browse and search across the whole ecosystem:

```bash
npx skills find
```

> **Note:** This repo previously distributed three Claude Code plugins via a `marketplace.json` catalog. That distribution path has been removed. Reinstall via the `skills` CLI.

## Available Skills

All skills live under [`skills/`](./skills) at the repo root. Each is a self-contained `SKILL.md` (with optional `references/`).

| Skill | Description |
| --- | --- |
| [`cli-skill-generator`](./skills/cli-skill-generator) | Discover commands of any CLI tool and generate a complete skill bundle documenting it. |
| [`plugin-analyzer`](./skills/plugin-analyzer) | Analyze a skill/plugin with multiple AI models in parallel, synthesize consensus findings, and optionally file GitHub issues. |
| [`consensus-planner`](./skills/consensus-planner) | Multi-model iterative consensus planning — spawns parallel agents to create, critique, and converge on an implementation plan. |
| [`review-loop`](./skills/review-loop) | Automated cross-vendor code review loop — implements a task, then runs Copilot CLI with a different-vendor model (e.g. Claude Code → GPT 5.4, or vice versa) to produce an independent review. Cross-platform (macOS, Linux, Windows). |

After installing, your agent will load these skills automatically when their trigger conditions match (each `SKILL.md` declares a "Use when …" description). You can also invoke a skill by name in your agent's UI.

## Repository Layout

```
agent-plugins/
├── skills/                   # Each subdirectory is one skills.sh skill
│   ├── cli-skill-generator/
│   │   ├── SKILL.md
│   │   └── references/
│   ├── plugin-analyzer/
│   │   ├── SKILL.md
│   │   └── references/
│   ├── consensus-planner/
│   │   ├── SKILL.md
│   │   └── references/
│   └── review-loop/
│       ├── SKILL.md
│       └── references/
├── .templates/skill-template/ # Starter for new skills
├── scripts/                   # Validation + listing utilities (Bun + TS)
├── CONTRIBUTING.md
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## SKILL.md Format

Each `SKILL.md` starts with a YAML frontmatter block:

```yaml
---
name: cli-skill-generator
description: "Use when ... (one sentence so the agent can route to it)."
license: MIT
metadata:
  author: filipmares
  version: '2.0.0'
---
```

This matches the [Agent Skills format](https://skills.sh) used across the ecosystem (see [`vercel-labs/agent-skills`](https://github.com/vercel-labs/agent-skills) for additional examples).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). To add a skill: copy `.templates/skill-template/` into `skills/<your-skill>/`, edit `SKILL.md`, validate with `bun run scripts/validate-skill.ts skills/<your-skill>`, and open a PR.

## License

[MIT](./LICENSE)
