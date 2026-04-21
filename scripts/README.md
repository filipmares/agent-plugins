# Skill Scripts

TypeScript utilities for validating and listing skills, run with [Bun](https://bun.sh).

## Prerequisites

- Bun runtime installed (`curl -fsSL https://bun.sh/install | bash`)

## Scripts

### `validate-skill.ts`

Validates that a skill follows the [skills.sh](https://skills.sh) format.

```bash
bun run scripts/validate-skill.ts <path-to-skill>
```

Examples:

```bash
bun run scripts/validate-skill.ts .templates/skill-template
bun run scripts/validate-skill.ts skills/cli-skill-generator
```

Checks:

- `SKILL.md` exists at the skill root
- YAML frontmatter is present
- Required fields: `name` (lowercase + hyphens), `description`
- Recommended fields: `license`, `metadata.author`, `metadata.version`
- Body contains at least one Markdown heading

Exits non-zero on errors.

### `list-skills.ts`

Lists every skill under `skills/` with its name, version, author, license, supporting-file counts, and validation status.

```bash
bun run scripts/list-skills.ts
```

Equivalent npm scripts:

```bash
bun run validate skills/<name>
bun run list
```

## For Contributors

Before submitting a skill:

1. Run `bun run scripts/validate-skill.ts skills/<your-skill>` and resolve any errors.
2. Run `bun run scripts/list-skills.ts` to confirm it appears.
3. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Development

Scripts use Bun's native TypeScript support — no compilation step.
