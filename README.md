# Agent Skills

A collection of reusable skills for AI coding agents (Claude Code, Cursor, GitHub Copilot, Aider, …), distributed via [skills.sh](https://skills.sh) — the open ecosystem and CLI for AI-agent skills.

Skills are packaged instructions (and optional supporting files) that extend an agent's capabilities. Unlike a code library, a skill is procedural knowledge the agent loads on demand.

## Installation

### GitHub Copilot CLI

This repo is also a [Copilot CLI plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace). Register it once, then install the bundled plugin (five skills and the **Copilot Code Review** agent):

```bash
copilot plugin marketplace add filipmares/agent-plugins
copilot plugin install agent-plugins@agent-plugins
```

Update later with `copilot plugin update agent-plugins`.

### Experimental canvas extension

The repository contains an optional, standalone **RPI Artifact Navigator**
canvas under [`extensions/rpi-artifact-navigator/`](./extensions/rpi-artifact-navigator).
It is not project-scoped and is not activated just by opening this repository.

In the GitHub Copilot app, open **Customize → Extensions → Import canvas from
repo**, choose `filipmares/agent-plugins`, and select
`extensions/rpi-artifact-navigator/` when prompted. Canvas support is
experimental and verified only on macOS with GitHub Copilot CLI 1.0.80.

See [`extensions/rpi-artifact-navigator/`](./extensions/rpi-artifact-navigator)
for the extension implementation and tests.

### skills.sh CLI

The [skills](https://skills.sh) CLI detects which agent you're using and installs each skill in the right place (e.g. `.claude/skills/`, `.cursor/skills/`, …).

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

## Available Content

### Copilot Code Review agent

The plugin includes the user-invocable **Copilot Code Review** agent. Use it to review a supplied PR, diff, commit, range, or path scope for evidence-based regressions; it reports findings but does not implement fixes or alter repository state.

### Skills

All skills live under [`skills/`](./skills) at the repo root. Each is a self-contained `SKILL.md` (with optional `references/`).

| Skill | Description |
| --- | --- |
| [`cli-skill-generator`](./skills/cli-skill-generator) | Discover commands of any CLI tool and generate a complete skill bundle documenting it. |
| [`plugin-analyzer`](./skills/plugin-analyzer) | Analyze a skill/plugin with multiple AI models in parallel, synthesize consensus findings, and optionally file GitHub issues. |
| [`consensus-planner`](./skills/consensus-planner) | Multi-model iterative consensus planning — spawns parallel agents to create, critique, and converge on an implementation plan. |
| [`copilot-migrate`](./skills/copilot-migrate) | Move a GitHub Copilot installation between machines, across operating systems, rewriting the absolute paths stored in its databases. |
| [`agent-merge`](./skills/agent-merge) | Scope discipline for unattended PR-review rounds — decide which review comments to implement, record each decision as a hidden marker, and audit them later. |

After installing through Copilot CLI, skills load automatically when their trigger conditions match (each `SKILL.md` declares a "Use when …" description), and the code review agent is available by name. The skills.sh installation remains skill-only: it installs the skills listed above, not Copilot plugin agents.

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
│   ├── copilot-migrate/
│   │   ├── SKILL.md
│   │   └── scripts/
│   └── agent-merge/
│       ├── SKILL.md
│       └── scripts/
├── .templates/skill-template/ # Starter for new skills
├── .github/
│   ├── agents/                # Copilot CLI agent definitions
│   │   └── copilot-code-review.agent.md
│   └── plugin/                # Copilot CLI marketplace.json + plugin.json
├── extensions/rpi-artifact-navigator/ # Standalone Copilot canvas extension
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
