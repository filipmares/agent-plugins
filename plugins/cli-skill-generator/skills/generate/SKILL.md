---
name: generate
description: "Use when creating a new CLI tool documentation plugin. Guides discovery of CLI commands, grouping into skills, and generating all plugin files. Trigger on requests like 'create a plugin for <tool> CLI' or 'generate skills for <tool>'."
---

# CLI Skill Generator

Generate a complete CLI tool documentation plugin by following these steps in order. Do not skip steps.

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

Run the tool's help to enumerate all available commands. Run help commands in parallel using parallel tool calls.

```
<TOOL_NAME> --help
```

If the tool uses subcommand groups (e.g., `docker container`, `aws s3`), also run help on each group to get the full command tree. Limit depth to 2 levels.

### Handling Large CLI Tools

If the top-level help reveals more than 15 command groups:
1. Classify groups into tiers:
   - **Tier 1 (Core):** Groups most developers use daily. Explore fully (run `--help`).
   - **Tier 2 (Common):** Used regularly. Explore with `--help`.
   - **Tier 3 (Niche/Preview):** Specialized features. Use the one-line description from top-level help — do not run `--help` on these.
2. Run `--help` on Tier 1 and Tier 2 groups in parallel.
3. For Tier 3 groups: include them in the command manifest and assign to broader skill groups using only their top-level descriptions.

All tiers are captured in the command manifest and assigned to skills — none are skipped.

### Command Manifest

After running help, produce a **complete structured list of ALL discovered top-level commands/groups**. This is the ground truth for the rest of the workflow. Every subsequent step must account for every entry.

Capture for each command:
- Command name
- One-line description
- Tier classification (for large tools)
- Key flags (only the most commonly used — for Tier 1/2 commands)

**Do NOT document every flag.** Focus on the flags a developer would use daily.

Present the manifest to the user:

```
Command Manifest for <TOOL_NAME> (<count> commands/groups discovered):

Tier 1 (Core):
  <command> — <description>
  ...

Tier 2 (Common):
  <command> — <description>
  ...

Tier 3 (Niche):
  <command> — <description>
  ...
```

For small tools (under 15 groups), tier classification is optional — list all commands directly.

---

## Step 3: Group Commands into Skill Domains

Analyze the command manifest and autonomously group ALL commands into skill domains.

**Scaling guidelines:**
- **Small tools** (under 30 commands): 5-7 skills
- **Medium tools** (30-60 commands): 7-10 skills
- **Large tools** (60+ commands): 10-15 skills
- Scale to achieve full coverage — every command in the manifest must be assigned to a skill group

Each group should:
- Cover a coherent area of functionality
- Contain 3-15 related commands
- Have a clear, descriptive name using lowercase and hyphens (e.g., `container-management`, `image-building`)

For large tools with Tier 3/niche groups: fold them into broader catch-all skill domains (e.g., `administration-and-extensions`, `data-services`) rather than skipping them.

**Present the grouping to the user as an informational summary:**

```
Skill grouping for <TOOL_NAME> (<N> skills covering <M> commands — 100% manifest coverage):

1. <group-name> — <brief description> (N commands)
   Commands: <cmd1>, <cmd2>, ...
2. <group-name> — <brief description> (N commands)
   Commands: <cmd1>, <cmd2>, ...
...
```

The user may suggest adjustments. Apply any feedback, then continue. Do not block on confirmation — this is informational, not a gate.

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
├── references/                   # Shared reference files (if applicable)
│   ├── version-check.md          # Version check instructions (if cliVersion known)
│   └── global-patterns.md        # Global flags & patterns (if tool has 3+ global flags)
└── README.md
```

### 4b: Create plugin.json

Follow the template in [references/plugin-structure.md](references/plugin-structure.md).

Set:
- `name`: `<TOOL_NAME>-cli`
- `version`: `1.0.0`
- `description`: A concise description of what the plugin covers
- `author`: `{ "name": "AUTHOR_NAME" }` (as an object, from Step 1)
- `skills`: `"./skills/"` (top-level string path, not nested under `capabilities`)
- `cliVersion`: `TOOL_VERSION` from Step 1 (omit this field entirely if `TOOL_VERSION` is `"unknown"`)

### 4c: Create SKILL.md Files

Generate SKILL.md files in parallel since they are independent.

For each skill group, create a `SKILL.md` following [references/skill-template.md](references/skill-template.md).

**Total plugin size budget:** ~16 KB target, 32 KB max across all files. For 7+ skills, aim for 100-200 lines per skill. Limit flag tables to 3 flags per command.

Key rules:
- If `TOOL_VERSION` is not `"unknown"`, generate a shared `references/version-check.md` and link to it from each SKILL.md (see Step 4d)
- The `description` in frontmatter must start with "Use when working with..."
- Keep descriptions under 150 characters — make them specific enough to route queries precisely
- Stay under 500 lines per SKILL.md
- If a skill would exceed 500 lines, split reference material into a `references/` subdirectory

**Two-tier command documentation within each skill:**

- **Core commands** (Tier 1/2): Full documentation — description, flag table (3-5 flags), example (~15 lines per command)
- **Minor commands** (Tier 3): Compact format — command name, one-line description, one example, no flag table (~5 lines per command)

This gives full coverage while keeping each skill under 300 lines even with 15+ commands.

### 4d: Create Shared Version Check Reference

If `TOOL_VERSION` is not `"unknown"`, create `OUTPUT_DIR/references/version-check.md` containing the version check instructions (see [references/skill-template.md](references/skill-template.md) for the full version check logic).

In each generated SKILL.md, instead of repeating the full version check block, include:

```markdown
## Version Check

See [version-check.md](../references/version-check.md) for version verification.
```

If `TOOL_VERSION` is `"unknown"`, skip creating the shared file and omit the section from each SKILL.md.

### 4e: Create Global Patterns Reference (if applicable)

If the CLI tool has 3 or more global flags (flags that apply to every or most commands — e.g., `--output`, `--query`, `--verbose`, `--subscription`):

1. Create `OUTPUT_DIR/references/global-patterns.md` covering:
   - Global flags with descriptions
   - Output formatting options
   - Query/filter syntax (if applicable)
   - Common environment variables

2. Reference it from each SKILL.md where relevant:
   ```markdown
   See [global-patterns.md](../references/global-patterns.md) for global flags and output formatting.
   ```

3. Do NOT duplicate global flags in individual skill flag tables — reference the shared file instead.

### 4f: Coverage Verification

After generating all SKILL.md files, cross-reference the command manifest from Step 2 against generated content:

1. List every command from the manifest
2. For each command, confirm it appears in at least one generated SKILL.md
3. Any command from the manifest not documented in a SKILL.md is a generation failure — add it to the appropriate skill before proceeding

This step is mandatory. Do not proceed to Step 4g until 100% coverage is confirmed.

### 4g: Create README.md

Follow the template in [references/plugin-structure.md](references/plugin-structure.md). Include:
- H1 heading with the tool name
- `## Overview` — what the plugin provides
- `## Installation` — how to add the plugin to Claude Code
- `## Usage` — list of skills with one-line descriptions

---

## Step 5: Validate

Read back each generated file from disk (do not rely on memory). For plugins with 5+ skills, use a subagent to validate.

1. **Required files exist:**
   - `OUTPUT_DIR/.claude-plugin/plugin.json` exists
   - `OUTPUT_DIR/README.md` exists

2. **plugin.json is valid:**
   - File parses as valid JSON
   - All required fields present: `name`, `version`, `description`, `author`, `skills`
   - `author` is an object with a `name` field
   - `skills` is a string path (e.g., `"./skills/"`)

3. **Skills match directory:**
   - For each skill directory under `OUTPUT_DIR/skills/`, verify `SKILL.md` exists
   - Each SKILL.md has valid YAML frontmatter with `name` and `description` fields
   - Each `description` starts with "Use when working with..."

4. **README structure:**
   - Starts with a main heading (`# Title`)
   - Contains `## Overview`, `## Installation`, and `## Usage` sections

5. **Version information** (only if `TOOL_VERSION` is not `"unknown"`):
   - `plugin.json` contains a `cliVersion` field matching `TOOL_VERSION`
   - `OUTPUT_DIR/references/version-check.md` exists
   - Each SKILL.md includes a `## Version Check` section linking to the shared reference

6. **Global patterns** (only if `references/global-patterns.md` was created):
   - The file exists and is non-empty
   - Individual skill flag tables do not duplicate global flags

7. **Command coverage:**
   - Every command from the Step 2 manifest appears in at least one SKILL.md

**If any check fails:** Fix the issue and re-check until all validations pass.

See [references/validation-checklist.md](references/validation-checklist.md) for the full checklist.

---

## Step 6: Summary

Present the user with a summary:

```
Plugin created: <TOOL_NAME>-cli
Location: <OUTPUT_DIR>
Author: <AUTHOR_NAME>
CLI Version: <TOOL_VERSION>
Skills: <count> skills covering <count> commands
Command coverage: 100% (<count>/<count> manifest entries)
Validation: Passed

Skills:
- <group-1>: <brief description>
- <group-2>: <brief description>
...

Shared references:
- version-check.md (if applicable)
- global-patterns.md (if applicable)
```

---

## Step 7: Finalize

After presenting the summary:

1. **Register the plugin:** Offer to register the plugin by running `/plugin add <OUTPUT_DIR>`.
2. **Commit (if applicable):** If inside a git repository, offer to commit the generated plugin files.
3. **Smoke test:** Suggest invoking one generated skill to verify it loads correctly (e.g., `/<TOOL_NAME>-cli:<first-skill-name>`).
