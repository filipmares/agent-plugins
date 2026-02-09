# Plugin Analyzer

## Overview

A skill that analyzes plugins using multiple AI models in parallel, synthesizes
consensus findings, detects duplicate issues, and optionally creates GitHub
issues. Works with both GitHub Copilot CLI (full cross-vendor model pool) and
Claude Code (Anthropic models only). Models are discovered dynamically at
runtime — no hardcoded lists.

## Installation

```
/plugin install plugin-analyzer@agent-plugins
```

## Usage

Ask the agent to analyze any plugin:

- "Analyze the cli-skill-generator plugin"
- "Review plugins/my-plugin for improvements"
- Or invoke directly: `/plugin-analyzer:analyze`

The skill walks through a structured workflow:

1. **Setup** — Validate the target plugin, discover available models, detect runtime
2. **Configure** — User selects 2-4 models from the dynamically discovered pool
3. **Analyze** — Launch parallel model agents with a structured analysis prompt
4. **Synthesize** — Categorize findings into consensus, single-model, and disagreements
5. **Dedup** — Search existing GitHub issues to avoid duplicates
6. **Create** — File GitHub issues for non-duplicate findings (skipped in dry-run mode)
7. **Report** — Present summary with links, stats, and model attribution

### Dry-Run Mode

Choose dry-run at Step 2 to get the analysis and consensus report without
creating any GitHub issues. Useful for reviewing analysis quality first.

### Runtime Compatibility

| Runtime | Model Pool | Detection |
|---------|-----------|-----------|
| **Copilot CLI** | Claude + GPT + Gemini (cross-vendor) | Non-Anthropic models present |
| **Claude Code** | Claude only (cross-tier) | Only Anthropic models present |

The same skill works in both environments. The agent reads its own `task` tool
documentation to discover available models at runtime.
