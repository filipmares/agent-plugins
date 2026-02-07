# CLI Skill Generator

## Overview

A skill that generates CLI tool documentation plugins for use with Claude Code.
Guides Claude through discovering CLI commands, grouping them into skills, and
producing a complete plugin in any directory you choose.

## Installation

```
/plugin install cli-skill-generator@tinytoolstown-marketplace
```

## Usage

Ask Claude to create a plugin for any CLI tool:

- "Generate skills for kubectl"
- "Create CLI skills for Docker"
- Or invoke directly: `/cli-skill-generator:generate`

The skill walks through a multi-step workflow:

1. Verify the CLI tool is installed
2. Choose an output directory for the generated plugin
3. Discover commands via `--help`
4. Group commands into 5-7 skill domains
5. Generate all plugin files (plugin.json, SKILL.md files, README)
6. Verify generated plugin structure
