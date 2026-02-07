---
name: generate
description: "Use when creating a new CLI tool documentation plugin. Guides discovery of CLI commands, grouping into skills, and generating all plugin files. Trigger on requests like 'create a plugin for <tool> CLI' or 'generate skills for <tool>'."
---

# CLI Skill Generator

Generate a complete CLI tool documentation plugin by following these steps in order. Do not skip steps. Confirm with the user before proceeding past each major step.

---

## Step 1: Identify the CLI Tool

Ask the user which CLI tool to generate a plugin for. Get the exact command name (e.g., `docker`, `kubectl`, `gh`, `aws`).

**Verify the tool is installed:**

On Windows:
```
where <tool>
```

On macOS/Linux:
```
which <tool>
```

**If the tool is NOT found:** Stop immediately. Tell the user:
> The `<tool>` CLI is not installed or not on PATH. Please install it first, then re-run this skill.

**If found:** Continue. Store the tool name as `TOOL_NAME` for the rest of the workflow.

**Capture the CLI tool version:**

Run:
```
<TOOL_NAME> --version
```

If that fails or produces no parseable version, try:
```
<TOOL_NAME> version
```

Extract the semantic version string (strip any leading `v`, e.g., `v2.27.0` becomes `2.27.0`). Store this as `TOOL_VERSION`.

If neither command produces a parseable version, set `TOOL_VERSION` to `"unknown"` and inform the user:
> Could not determine the version of `<TOOL_NAME>`. The generated plugin will not include version checking.

**Ask where to save the generated plugin.** Suggest a default of `.claude/plugins/<TOOL_NAME>-cli/` in the user's current project directory, but let them specify any path. Store the chosen path as `OUTPUT_DIR`.

**Ask for author name.** Ask the user for their name or organization to use as the plugin author. Store this as `AUTHOR_NAME`.

---

## Step 2: Discover Commands

Run the tool's help to enumerate all available commands:

```
<TOOL_NAME> --help
```

If the tool uses subcommand groups (e.g., `docker container`, `aws s3`), also run help on each group to get the full command tree. Limit depth to 2 levels.

Capture for each command:
- Command name
- One-line description
- Key flags (only the most commonly used)

**Do NOT document every flag.** Focus on the flags a developer would use daily.

---

## Step 3: Group Commands into Skill Domains

Analyze the discovered commands and propose **5-7 functional groups** (skill domains). Each group should:
- Cover a coherent area of functionality
- Contain 3-10 related commands
- Have a clear, descriptive name using lowercase and hyphens (e.g., `container-management`, `image-building`)

**Present the proposed grouping to the user as a numbered list:**

```
Proposed skill groups for <TOOL_NAME>:
1. <group-name> — <brief description> (N commands)
2. <group-name> — <brief description> (N commands)
...
```

**Wait for user confirmation.** They may want to rename groups, merge groups, or split them differently. Adjust as needed before continuing.

---

## Step 4: Generate Plugin Files

Now create the full plugin. Use the templates in `references/` as your guide.

### 4a: Create Directory Structure

Create the following structure under `OUTPUT_DIR`:

```
<OUTPUT_DIR>/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── <group-1>/
│   │   └── SKILL.md
│   ├── <group-2>/
│   │   └── SKILL.md
│   └── ... (one per group)
└── README.md
```

### 4b: Create plugin.json

Follow the template in [references/plugin-structure.md](references/plugin-structure.md).

Set:
- `name`: `<TOOL_NAME>-cli`
- `version`: `1.0.0`
- `description`: A concise description of what the plugin covers
- `author`: `AUTHOR_NAME` (from Step 1)
- `capabilities.skills`: Array of all group names from Step 3
- `cliVersion`: `TOOL_VERSION` from Step 1 (omit this field entirely if `TOOL_VERSION` is `"unknown"`)

### 4c: Create SKILL.md Files

For each skill group, create a `SKILL.md` following [references/skill-template.md](references/skill-template.md).

Key rules:
- If `TOOL_VERSION` is not `"unknown"`, every generated SKILL.md must include a `## Version Check` section immediately after the H1 heading and summary, following the preamble defined in [references/skill-template.md](references/skill-template.md)
- The `description` in frontmatter must start with "Use when working with..."
- Keep descriptions under 150 characters
- Document commands with: command syntax, key flags (table), and one example
- Only include non-obvious information — skip flags a developer can guess
- Stay under 500 lines per SKILL.md
- If a skill would exceed 500 lines, split reference material into a `references/` subdirectory

### 4d: Create README.md

Follow the template in [references/plugin-structure.md](references/plugin-structure.md). Include:
- H1 heading with the tool name
- `## Overview` — what the plugin provides
- `## Installation` — how to add the plugin to Claude Code
- `## Usage` — list of skills with one-line descriptions

---

## Step 5: Validate

Perform a structural self-check on the generated plugin:

1. **Required files exist:**
   - `OUTPUT_DIR/.claude-plugin/plugin.json` exists
   - `OUTPUT_DIR/README.md` exists

2. **plugin.json is valid:**
   - File parses as valid JSON
   - All required fields present: `name`, `version`, `description`, `author`, `capabilities`

3. **Skills match capabilities:**
   - For each skill listed in `capabilities.skills`, verify `OUTPUT_DIR/skills/<name>/SKILL.md` exists
   - Each SKILL.md has valid YAML frontmatter with `name` and `description` fields
   - Each `description` starts with "Use when working with..."

4. **README structure:**
   - Starts with a main heading (`# Title`)
   - Contains `## Overview`, `## Installation`, and `## Usage` sections

5. **Version information** (only if `TOOL_VERSION` is not `"unknown"`):
   - `plugin.json` contains a `cliVersion` field matching `TOOL_VERSION`
   - Each SKILL.md includes a `## Version Check` section

**If any check fails:** Fix the issue and re-check until all validations pass.

---

## Step 6: Summary

Present the user with a summary:

```
Plugin created: <TOOL_NAME>-cli
Location: <OUTPUT_DIR>
Author: <AUTHOR_NAME>
CLI Version: <TOOL_VERSION>
Skills: <count> skills covering <count> commands
Validation: ✓ Passed

Skills:
- <group-1>: <brief description>
- <group-2>: <brief description>
...

To use this plugin, add it to your Claude Code configuration.
```

Ask the user if they'd like to adjust anything before finalizing.
