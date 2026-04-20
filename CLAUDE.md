# CLAUDE.md

A collection of agent skills distributed via [skills.sh](https://skills.sh).

## Tech Stack

- **Bun** + **TypeScript** for scripts. No build step.

## Key Commands

```bash
bun run scripts/validate-skill.ts <path-to-skill>   # Validate a single skill
bun run scripts/list-skills.ts                      # List all skills with status
```

## Project Structure

```
skills/                # Each subdirectory is one skills.sh skill (skills/<name>/SKILL.md)
scripts/               # Validation and listing scripts (Bun + TS)
.templates/            # Starter template for new skills
```

## Skill Structure

Each skill lives in `skills/<name>/` and requires:

- `SKILL.md` — instructions with YAML frontmatter (`name`, `description`; recommended `license`, `metadata.author`, `metadata.version`)
- Optional `references/` — supporting files linked from `SKILL.md` with relative paths
- Optional `scripts/` — helper scripts the skill invokes

## Conventions

- Skill names must be globally unique (lowercase, hyphenated) — skills.sh installs into a shared directory
- `description` should start with "Use when …" so the agent can route to the skill
- Self-contained: a skill never references files outside its own directory
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for full guidelines
- Format follows the [Agent Skills](https://skills.sh) ecosystem ([reference repo](https://github.com/vercel-labs/agent-skills))
