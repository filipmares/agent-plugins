# Skill Template Reference

Use this template when generating individual SKILL.md files for CLI tool plugins.

---

## Frontmatter Format

Every SKILL.md must begin with YAML frontmatter:

```yaml
---
name: <skill-name>
description: "Use when working with <tool> <domain>. Covers <key commands>."
---
```

### Frontmatter Rules

- **name**: Lowercase, hyphens only. Must match the directory name (e.g., `skills/container-management/SKILL.md` has `name: container-management`).
- **description**: Must start with `"Use when working with..."`. Keep under 150 characters. Should help Claude decide when to load this skill.

### Good vs. Bad Descriptions

**Good:**
- `"Use when working with Docker container lifecycle. Covers run, stop, rm, logs, exec, and inspect."`
- `"Use when working with kubectl pod operations. Covers get, describe, logs, exec, and delete."`

**Bad:**
- `"Docker containers"` — too vague, doesn't start with "Use when"
- `"Use this skill for everything related to Docker including containers, images, networks, volumes, and all other Docker operations"` — too long, too broad
- `"Manages containers"` — doesn't follow format, not helpful for routing

---

## Body Structure

After frontmatter, structure the body as follows:

```markdown
# <Skill Title>

Brief one-line summary of what this skill covers.

## Version Check

<version check preamble — see Version Check Preamble section below>

## Commands

### `<tool> <command>`

<One sentence explaining what this does and when to use it.>

**Key flags:**

| Flag | Description |
|------|-------------|
| `--flag` | What it does |

**Example:**

```bash
<tool> <command> <typical usage>
```

### `<tool> <next-command>`

...repeat for each command in this group...
```

---

## Version Check Preamble

When `cliVersion` is present in the plugin's `plugin.json`, every generated SKILL.md must include a `## Version Check` section immediately after the H1 heading and summary line, before `## Commands`. This section instructs Claude to verify the user's installed CLI version at invocation time.

The `## Version Check` section should contain the following instructions (substituting the actual tool name):

1. Run `<TOOL> --version` to get the installed version. If that fails, try `<TOOL> version`.
2. Read `cliVersion` from this plugin's `plugin.json`.
3. Compare the two versions using semver rules:
   - **Same major, same or newer minor/patch** — proceed normally (no message needed).
   - **Same major, older minor/patch** — warn: _"Your `<TOOL>` version (X.Y.Z) is older than the version this plugin was documented against (A.B.C). Some commands or flags mentioned here may not be available."_ Then proceed.
   - **Newer major version** — warn: _"Your `<TOOL>` version (X.0.0) is a major version ahead of what this plugin was documented against (A.B.C). Commands may have changed significantly."_ Ask the user whether to proceed or stop (consider regenerating the plugin).
   - **Older major version** — warn: _"Your `<TOOL>` version (X.Y.Z) is a major version behind what this plugin was documented against (A.B.C). Many documented features may not exist in your version."_ Ask the user whether to proceed or stop (consider upgrading the CLI tool).
   - **Version not parseable or unavailable** — note: _"Could not determine `<TOOL>` version. Proceeding with documented commands — some may not match your installed version."_ Then proceed.

If `cliVersion` is **not** present in `plugin.json`, omit the `## Version Check` section entirely.

---

## Content Rules

1. **Only document non-obvious information.** Skip flags a developer can guess (e.g., `--help`, `--version`, `--verbose`).
2. **One example per command.** Show the most common real-world usage, not edge cases.
3. **Key flags only.** Include 3-5 of the most useful flags per command. Skip rarely-used options.
4. **Under 500 lines.** If a skill would exceed this, move detailed flag tables or advanced usage to `references/` files.
5. **No tutorials.** Skills are reference material, not guides. Assume the user knows the tool basics.
6. **Concrete values in examples.** Use realistic values, not placeholders like `<name>`. E.g., `docker run -d nginx` not `docker run -d <image>`.

---

## When to Split into References

Create a `references/` subdirectory if:
- A command has 10+ important flags that need documentation
- There are common workflow patterns worth documenting separately
- Configuration file formats need detailed reference

Reference files use plain markdown (no frontmatter needed).

---

## Size Budget

- **Per skill:** Aim for 100-300 lines. Max 500 lines.
- **Description:** 80-150 characters.
- **Commands per skill:** 3-10. If you have more, consider splitting the skill.
- **Flags per command:** 3-5 key flags in the main table.
