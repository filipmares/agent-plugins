# Contributing

Thanks for your interest in contributing! This repo distributes skills via [skills.sh](https://skills.sh) — a flat collection of self-contained skills in `skills/` at the repo root.

## Skill Format

Every skill must:

- Live in its own directory under `skills/<skill-name>/`
- Have a `SKILL.md` at the skill root with YAML frontmatter
- Use a globally unique, lowercase, hyphenated `name` (skills install into a shared directory inside the user's project)
- Have a clear `description` starting with **"Use when …"** so the agent can route to it

### Required `SKILL.md` frontmatter

```yaml
---
name: my-skill
description: "Use when <trigger condition>. Be specific so the agent can route precisely."
---
```

### Recommended frontmatter

```yaml
license: MIT
metadata:
  author: Your Name
  version: '1.0.0'
```

### Optional supporting files

```
skills/my-skill/
├── SKILL.md              # Required
├── references/           # Optional: prompts, templates, examples (linked with relative paths from SKILL.md)
└── scripts/              # Optional: helper scripts the skill invokes
```

A starter is provided in [`.templates/skill-template/`](./.templates/skill-template). Copy it to get going.

## Submission Workflow

1. **Fork and branch**

   ```bash
   git checkout -b add-<your-skill>
   ```

2. **Create your skill**

   ```bash
   cp -r .templates/skill-template skills/<your-skill>
   $EDITOR skills/<your-skill>/SKILL.md
   ```

3. **Validate**

   ```bash
   bun run scripts/validate-skill.ts skills/<your-skill>
   bun run scripts/list-skills.ts
   ```

4. **Test locally**

   Install your branch with the skills CLI to confirm it loads correctly in your agent:

   ```bash
   npx skills add <your-fork>/agent-plugins#<your-branch>
   ```

5. **Document & changelog**

   Update [`CHANGELOG.md`](./CHANGELOG.md) under `## [Unreleased]` with a one-line entry for your skill.

6. **Open a PR**

   Include in the description: what the skill does, when it triggers, and any external dependencies it expects (CLI tools, environment variables, etc.).

## Quality Standards

- **Single responsibility.** A skill should do one coherent thing well. Split unrelated workflows into separate skills.
- **Self-contained.** All files a skill needs (templates, prompts, examples) live under that skill's directory. Do not cross-reference files in other skills.
- **Globally unique name.** Since skills.sh installs into a shared directory, choose a descriptive name that is unlikely to collide with skills from other authors.
- **Concise but complete instructions.** Aim for under ~500 lines per `SKILL.md`. Move long reference material into `references/`.
- **Trigger-focused description.** The frontmatter `description` is what the agent uses to decide whether to load your skill — it should be specific and start with "Use when …".
- **No secrets.** Do not commit credentials, tokens, or proprietary data.

## Validation Tools

This repo uses [Bun](https://bun.sh) for its TypeScript scripts. No build step is required.

```bash
bun run scripts/validate-skill.ts skills/<name>   # Validate a single skill
bun run scripts/list-skills.ts                    # List all skills + status
```

CI runs the same checks against every skill in `skills/`.

## Code of Conduct

Be respectful and constructive. Help others and share knowledge. Report security issues privately rather than in public issues.

## License

By contributing, you agree your contribution is licensed under the [MIT License](./LICENSE).
