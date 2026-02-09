# Plugin Structure Reference

Use this reference when creating the directory structure and manifest for a CLI tool plugin.

---

## Directory Layout

```
<output-dir>/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (required)
├── skills/                   # One subdirectory per skill (required)
│   ├── <skill-1>/
│   │   ├── SKILL.md          # Skill definition (required)
│   │   └── references/       # Optional per-skill reference files
│   ├── <skill-2>/
│   │   └── SKILL.md
│   └── .../
├── references/               # Shared reference files (optional)
│   ├── version-check.md      # Version check instructions (if cliVersion known)
│   └── global-patterns.md    # Global flags & patterns (if tool has 3+ global flags)
└── README.md                 # Plugin documentation (required)
```

---

## plugin.json Template

```json
{
  "name": "<tool-name>-cli",
  "version": "1.0.0",
  "description": "<Concise description of what the plugin provides>",
  "author": { "name": "<author-name>" },
  "skills": "./skills/",
  "cliVersion": "<version>"
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Plugin name. Lowercase, hyphens only. Must match directory name. |
| `version` | string | Semantic version (e.g., `1.0.0`). |
| `description` | string | What the plugin does, 1 sentence. |
| `author` | object | Author info. Object with a `name` field (e.g., `{ "name": "Your Name" }`). |
| `skills` | string | Path to skills directory (e.g., `"./skills/"`). |
| `cliVersion` | string | Semantic version of the CLI tool at generation time (e.g., `2.27.0`). Omit if unknown. |

The `cliVersion` field records the version of the CLI tool that was installed when the plugin was generated. Generated skills use this to warn users when their installed version differs significantly, helping prevent issues with outdated or mismatched documentation.

---

## Naming Conventions

- **Plugin name:** `<tool>-cli` (e.g., `docker-cli`, `kubectl-cli`, `gh-cli`)
- **Skill names:** Lowercase, hyphens only. Descriptive domain names (e.g., `container-management`, `image-building`)
- **No underscores, no camelCase, no spaces.**

---

## README.md Template

```markdown
# <Tool Name> CLI

## Overview

Claude Code plugin providing reference documentation for the <Tool Name> CLI.
Covers <N> skill areas with commands for <brief summary of what's covered>.

## Installation

Add this plugin to your Claude Code configuration:

```
/plugin add <path-to-plugin>
```

## Usage

Available skills:

| Skill | Description |
|-------|-------------|
| `<skill-1>` | <one-line description> |
| `<skill-2>` | <one-line description> |
| ... | ... |

Invoke a skill directly:
```
/<tool-name>-cli:<skill-name>
```

Or ask Claude about <tool> commands and the relevant skill loads automatically.
```

### Required README Sections

The following sections should be present:
- `## Overview`
- `## Installation`
- `## Usage`

All three are recommended for a complete plugin.
