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
bun run validate:copilot-plugin                   # Validate the Copilot marketplace + plugin packages
bun run test:canvas                               # Run the canvas companion's test suite
```

CI runs the same checks against every skill in `skills/`.

## Copilot Canvas Extension

`extensions/rpi-artifact-navigator/` is a separate, opt-in GitHub Copilot
canvas extension. It is deliberately outside the skills.sh distribution: root
`skills/` and the `agent-plugins` marketplace entry are unaffected by it.

Working rules for that extension:

- The canvas is **read-only**. Do not add a write, edit, delete, rename, or move path.
- Reads stay inside the approved `.copilot-tracking` roots enforced in `artifact-index.mjs`. Widening that allowlist is a security change, not a convenience change.
- Extension modules depend only on the Node standard library and `@github/copilot-sdk`. Do not introduce a package manifest, lockfile, or third-party dependency unless the extension requires it.
- Browser-only third-party code must remain pinned and offline under
  `extensions/rpi-artifact-navigator/vendor/`. Update `vendor/manifest.json`
  with the exact version, npm tarball member, and SHA-256 digest; preserve the
  selected upstream license under `third-party-licenses/`; and serve only named
  files through capability-scoped routes. Do not add a CDN or general static
  file route.
- The Markdown boundary must drop raw HTML before DOMPurify, use explicit tag
  and attribute allowlists, build a detached fragment, and commit successful
  content once. Do not combine DOMPurify `USE_PROFILES` with `ALLOWED_TAGS`,
  because the profile overrides the explicit tag allowlist. Failures must clear
  stale content and remain visibly retryable without an unsanitized fallback.
- The per-instance HTTP server binds to `127.0.0.1` behind an unguessable path capability. Do not relax the `Host`, `Origin`, CORS, or Content-Security-Policy handling in `server.mjs`.
- Support claims for the canvas must name only configurations that were
  actually verified. Do not broaden them without new evidence.
- Keep automatic navigation self-contained and instance-scoped. Tool hooks may
  compare only approved artifacts before and after successful calls. Edits must
  refresh without taking focus and must not reopen an instance the user closed;
  a newly created artifact may reopen that task's panel.

Run `bun run test:canvas` before opening a PR that touches the canvas. Rendering
changes also require a macOS GitHub Copilot canvas check for supported Markdown,
hostile input, missing or throwing libraries, focus and refresh behavior, and
narrow and wide layouts; Bun assertions do not execute or attest the final DOM.

## Code of Conduct

Be respectful and constructive. Help others and share knowledge. Report security issues privately rather than in public issues.

## License

By contributing, you agree your contribution is licensed under the [MIT License](./LICENSE).
