# Agent Skills

A collection of reusable skills for AI coding agents (Claude Code, Cursor, GitHub Copilot, Aider, …), distributed via [skills.sh](https://skills.sh) — the open ecosystem and CLI for AI-agent skills.

Skills are packaged instructions (and optional supporting files) that extend an agent's capabilities. Unlike a code library, a skill is procedural knowledge the agent loads on demand.

## Installation

### GitHub Copilot CLI

This repo is also a [Copilot CLI plugin marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace). Register it once, then install the developer plugin (three skills, the **Copilot Code Review** agent, and the **RPI Artifact Navigator** canvas):

```bash
copilot plugin marketplace add filipmares/agent-plugins
copilot plugin install agent-plugins@agent-plugins
```

**Notes** is a separate plugin; it does not require the developer plugin:

```bash
copilot plugin install notes@agent-plugins
```

If you already use Notes bundled with `agent-plugins` 3.x or earlier, save and
close its panels, run `copilot plugin update agent-plugins` **before** installing
`notes`, then start a new session and reopen Notes. Existing notes, UI state,
and recovered drafts stay in their current locations; no data migration is needed.
Disable any manually imported Notes copy to avoid duplicate providers.

Update each plugin independently with `copilot plugin update agent-plugins`
or `copilot plugin update notes`. Updates are pull-based:
a self-registered marketplace does not auto-update unless you set
`"autoUpdate": true` on its `extraKnownMarketplaces` entry in your user settings.

### Experimental canvas extensions

The marketplace offers two experimental GitHub Copilot app canvases:

| Canvas | Plugin | Purpose |
| --- | --- | --- |
| [Notes](./plugins/notes/extensions/notes/) | `notes` | Global Markdown notes with rich/plain editing, session provenance, live sync, and Ask Copilot. |
| [RPI Artifact Navigator](./extensions/rpi-artifact-navigator/) | `agent-plugins` | Read-only, task-scoped navigation of approved RPI artifacts. |

Each canvas loads only while its owning plugin is enabled and can also be disabled
individually. Installing `agent-plugins` does not install Notes.
They are not project-scoped or activated just by opening this repository.
Start a new session after installing or updating to discover the canvases;
no separate canvas import is needed.

To take one canvas without the plugin, open **Customize → Extensions → Import
canvas from repo** in the GitHub Copilot app, choose `filipmares/agent-plugins`,
and select `plugins/notes/extensions/notes/` or `extensions/rpi-artifact-navigator/`
when prompted. A manual import is a one-time copy that receives no further
updates — re-import to pick up changes.

#### Notes

Ask Copilot to open the **Notes** canvas. Its folder/list/editor layout follows
the app's light/dark theme. Notes are ordinary `.md` files in your operating
system's Documents `Copilot Notes` folder, with YAML frontmatter recording the
creating session, project and branch. The `notes_manage` tool can also create,
search and edit notes without opening the panel. **Copilot** in the panel saves
the note before queuing your prompt with the note attached.

Discovery adds frontmatter to plain Markdown files already in the library.
Deletion uses OS trash; permanent deletion requires separate confirmation.
Uninstalling the `notes` plugin leaves your notes intact. See the
[Notes guide](./plugins/notes/extensions/notes/README.md) for screenshots, privacy, shortcuts,
developer commands and verification limits. Browser checks used headless Edge
on Windows with disposable notes; native-app interactions remain unverified.

#### RPI Artifact Navigator

This canvas has been verified on macOS with the GitHub Copilot app.
See its [extension guide](./extensions/rpi-artifact-navigator/) for the
implementation and tests.

The extension detects approved RPI artifacts created or edited by successful
agent tool calls. It opens a task-scoped panel for a new artifact and refreshes
that panel without taking focus on later edits. Closing a panel suppresses
edit-driven reopening until another artifact for that task is created. No
changes to HVE Core are required.

The document pane renders GitHub-flavored Markdown with pinned, offline copies
of Marked and DOMPurify. Raw HTML and control comments are omitted, images and
executable diagrams are not loaded, task-list inputs stay disabled, and links
are shown as non-navigating label-and-destination text so they cannot replace
the canvas. The artifact source remains authoritative and unchanged in the
extension API. If parsing or sanitization fails, the pane clears stale content
and shows a persistent read-only error; **Refresh from disk** retries rendering.

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

The `agent-plugins` plugin includes the user-invocable **Copilot Code Review** agent. Use it to review a supplied PR, diff, commit, range, or path scope for evidence-based regressions; it reports findings but does not implement fixes or alter repository state.

### Skills

All skills live under [`skills/`](./skills) at the repo root. Each is a self-contained `SKILL.md` (with optional `references/`).

| Skill | Description |
| --- | --- |
| [`cli-skill-generator`](./skills/cli-skill-generator) | Discover commands of any CLI tool and generate a complete skill bundle documenting it. |
| [`copilot-migrate`](./skills/copilot-migrate) | Move a GitHub Copilot installation between machines, across operating systems, rewriting the absolute paths stored in its databases. |
| [`agent-merge`](./skills/agent-merge) | Scope discipline for unattended PR-review rounds — decide which review comments to implement, record each decision as a hidden marker, and audit them later. |

After installing through Copilot CLI, skills load automatically when their trigger conditions match (each `SKILL.md` declares a "Use when …" description), and the code review agent is available by name. The skills.sh installation remains skill-only: it installs the skills listed above, not Copilot plugin agents or canvases.

## Repository Layout

```
agent-plugins/
├── skills/                   # Each subdirectory is one skills.sh skill
│   ├── cli-skill-generator/
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
│   └── plugin/                # Marketplace catalog + agent-plugins manifest
├── extensions/                # Canvases shipped by agent-plugins
│   └── rpi-artifact-navigator/ # Read-only RPI artifact navigation
├── plugins/
│   ├── agent-plugins/         # Changelog for the root plugin
│   │   └── CHANGELOG.md
│   └── notes/                 # Independently installable Notes plugin
│       ├── .github/plugin/    # Notes plugin manifest
│       ├── extensions/notes/  # Markdown library, tools, rich/plain panel
│       ├── CHANGELOG.md
│       └── LICENSE
├── scripts/                   # Validation + listing utilities (Bun + TS)
├── CONTRIBUTING.md
├── CHANGELOG.md               # Repository-wide changes
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
