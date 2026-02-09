# CLI Skill Generator

## Overview

A skill that generates CLI tool documentation plugins for use with Claude Code.
Guides Claude through discovering CLI commands, grouping them into skills, and
producing a complete plugin in any directory you choose. Handles tools of any
size — from small CLIs to massive tools like `az` with 80+ command groups.

## Installation

```
/plugin install cli-skill-generator@agent-plugins
```

## Usage

Ask Claude to create a plugin for any CLI tool:

- "Generate skills for kubectl"
- "Create CLI skills for Docker"
- Or invoke directly: `/cli-skill-generator:generate`

The skill walks through a multi-step workflow:

1. Verify the CLI tool is installed and capture its version
2. Discover commands via `--help`, produce a complete command manifest (with tier-based triage for large tools)
3. Autonomously group all commands into skill domains (5-15 skills, scaling with tool size)
4. Generate all plugin files:
   - `plugin.json` manifest
   - SKILL.md files (with two-tier documentation for large tools)
   - Shared `references/version-check.md` (if version known)
   - Shared `references/global-patterns.md` (if tool has global flags)
   - README
5. Verify coverage (every manifest command accounted for) and validate structure
6. Present summary
7. Offer to register the plugin, commit, and run a smoke test
