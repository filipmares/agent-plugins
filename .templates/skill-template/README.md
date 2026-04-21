# Skill Template

Starter template for a [skills.sh](https://skills.sh)-compatible skill.

## Layout

```
your-skill/
├── SKILL.md            # Required: instructions + YAML frontmatter
├── references/         # Optional: supporting docs, prompts, examples
└── scripts/            # Optional: helper scripts
```

## SKILL.md frontmatter

Required:

- `name` — globally unique, lowercase, hyphens only (this is what users will see in their agent)
- `description` — one sentence starting with "Use when …" so the agent can route to it

Recommended:

- `license` — SPDX identifier (e.g. `MIT`)
- `metadata.author` — your name or org
- `metadata.version` — semantic version

## Adding a skill to this repo

1. Copy this template into `skills/<your-skill-name>/`.
2. Edit `SKILL.md`: pick a globally unique `name`, write a clear "Use when …" description, and replace the body with your instructions.
3. Validate: `bun run scripts/validate-skill.ts skills/<your-skill-name>`.
4. List: `bun run scripts/list-skills.ts` to confirm it shows up.
5. Open a PR — see [CONTRIBUTING.md](../../CONTRIBUTING.md).
