# CLAUDE.md

Claude Code plugin marketplace. Currently empty and accepting contributions.

## Tech Stack

- **Bun** + **TypeScript** for scripts. No build step.

## Key Commands

```bash
bun run scripts/validate-plugin.ts <path-to-plugin>   # Validate a plugin
bun run scripts/list-plugins.ts                        # List all plugins
```

## Project Structure

```
plugins/          # Plugin directories (each is plugins/<name>/)
scripts/          # Validation and listing scripts (Bun + TS)
.claude-plugin/   # Marketplace-level manifest (marketplace.json)
.templates/       # Plugin scaffolding template
```

## Plugin Structure

Each plugin lives in `plugins/<name>/` and requires:
- `.claude-plugin/plugin.json` — manifest with name, version, description, author, categories, capabilities
- `README.md` — documentation

## Valid Categories

`development-tools`, `productivity`, `web-tools`, `data-tools`, `testing`, `security`, `documentation`, `deployment`

## Conventions

- See [CONTRIBUTING.md](./CONTRIBUTING.md) for full contributor guidelines
- Follows [Anthropic plugin marketplace guidelines](https://code.claude.com/docs/en/plugin-marketplaces)
