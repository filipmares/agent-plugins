# Validation Checklist

Use this reference to verify a generated plugin is structurally correct and follows quality guidelines.

---

## Structural Validation

### Required Files
- `README.md` exists
- `.claude-plugin/plugin.json` exists

### Required Fields in plugin.json
- `name` — must be present
- `version` — must be present
- `description` — must be present
- `author` — must be present
- `capabilities` — must be present
- `cliVersion` — must be present if CLI version was captured during generation

### Capability Matching
For each skill listed in `capabilities.skills`, verify that `skills/<name>/SKILL.md` exists. Each SKILL.md must have valid YAML frontmatter with `name` and `description` fields.

Same for `capabilities.commands` — each must have `commands/<name>/COMMAND.md`.

### README Checks
- Should start with a main heading (`# Title`)
- Should include `## Overview`, `## Installation`, `## Usage` sections

---

## Budget Guidelines

Keep generated plugins within these budgets:

| Metric | Target | Maximum |
|--------|--------|---------|
| Skills per plugin | 5-7 | 10 |
| Commands per skill | 3-10 | 15 |
| Description length | ~100 chars | 150 chars |
| SKILL.md lines | 100-300 | 500 |
| Total plugin size | ~16 KB | 32 KB |

---

## Quality Checklist

Before considering the plugin complete, verify:

- [ ] `plugin.json` has all required fields
- [ ] `plugin.json` parses as valid JSON
- [ ] Every skill in `capabilities.skills` has a corresponding `skills/<name>/SKILL.md`
- [ ] Every SKILL.md has valid frontmatter with `name` and `description`
- [ ] Descriptions start with "Use when working with..."
- [ ] README.md has Overview, Installation, and Usage sections
- [ ] Total skill count is 5-7
- [ ] No SKILL.md exceeds 500 lines
- [ ] `plugin.json` includes `cliVersion` if CLI version was captured during generation
- [ ] Every SKILL.md includes a `## Version Check` section (if `cliVersion` is present in `plugin.json`)
