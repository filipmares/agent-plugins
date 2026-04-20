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
- `author` — must be present, must be an object with a `name` field (e.g., `{ "name": "Author Name" }`)
- `skills` — must be present, must be a string path (e.g., `"./skills/"`)
- `cliVersion` — must be present if CLI version was captured during generation

### Skill Matching
For each skill directory under `skills/`, verify that `SKILL.md` exists. Each SKILL.md must have valid YAML frontmatter with `name` and `description` fields.

### README Checks
- Should start with a main heading (`# Title`)
- Should include `## Overview`, `## Installation`, `## Usage` sections

---

## Budget Guidelines

Keep generated plugins within these budgets:

| Metric | Target | Maximum |
|--------|--------|---------|
| Skills per plugin (small tools) | 5-7 | 15 |
| Skills per plugin (large tools) | 10-15 | 15 |
| Commands per skill | 3-10 | 15 |
| Description length | ~100 chars | 150 chars |
| SKILL.md lines (5-7 skills) | 200-300 | 500 |
| SKILL.md lines (10+ skills) | 100-200 | 500 |
| Total plugin size | ~16 KB | 32 KB |

---

## Shared Reference Files

### Version Check (`references/version-check.md`)
- Must exist if `cliVersion` is present in `plugin.json`
- Each SKILL.md must include a `## Version Check` section linking to this file
- Should NOT be created if `cliVersion` is unknown or absent

### Global Patterns (`references/global-patterns.md`)
- Should exist if the CLI tool has 3+ global flags
- Should cover global flags, output formatting, and query syntax
- Individual skill flag tables must NOT duplicate flags documented here

---

## Command Coverage

- Every command discovered in the Step 2 manifest must appear in at least one generated SKILL.md
- No commands may be silently dropped during grouping or generation
- For large tools, Tier 3 commands may use compact format (name + one-line description + one example) but must still be present

---

## Quality Checklist

Before considering the plugin complete, verify:

- [ ] `plugin.json` has all required fields
- [ ] `plugin.json` parses as valid JSON
- [ ] `plugin.json` uses correct schema (`author` as object, `skills` as string path)
- [ ] Every skill directory has a corresponding `skills/<name>/SKILL.md`
- [ ] Every SKILL.md has valid frontmatter with `name` and `description`
- [ ] Descriptions start with "Use when working with..."
- [ ] README.md has Overview, Installation, and Usage sections
- [ ] Total skill count is appropriate (5-7 for small tools, up to 15 for large tools)
- [ ] No SKILL.md exceeds 500 lines
- [ ] `plugin.json` includes `cliVersion` if CLI version was captured during generation
- [ ] `references/version-check.md` exists and each SKILL.md links to it (if `cliVersion` is present)
- [ ] `references/global-patterns.md` exists if the tool has 3+ global flags
- [ ] Global flags are not duplicated in individual skill flag tables
- [ ] 100% command coverage: every manifest entry appears in at least one SKILL.md
