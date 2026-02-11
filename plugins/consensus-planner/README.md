# Consensus Planner

## Overview

A skill that creates implementation plans using multiple AI models in parallel, runs iterative feedback rounds where each model critiques and refines all plans, and synthesizes a consensus plan. Works with both GitHub Copilot CLI (full cross-vendor model pool) and Claude Code (Anthropic models only). Models are discovered dynamically at runtime — no hardcoded lists.

## Installation

```
/plugin install consensus-planner@agent-plugins
```

## Usage

Ask the agent to create a consensus plan:

- "Create a consensus plan for adding authentication to the API"
- "Multi-model plan for refactoring the database layer"
- Or invoke directly with the skill tool

The skill walks through a structured workflow:

1. **Setup** — Gather the task description and relevant codebase context automatically
2. **Configure** — Select 1–5 models from the dynamically discovered pool, choose feedback rounds (2/3/5)
3. **Plan** — Launch parallel agents that independently produce structured implementation plans
4. **Iterate** — Each agent reviews all plans, critiques them, and revises their own; repeat until convergence or max rounds
5. **Synthesize** — Merge final plans into a consensus report with confidence markers
6. **Report** — Present the merged plan with consensus breakdown, open questions, and model attribution

### Single-Model Mode

If only 1 model is selected, the skill produces a single plan without feedback rounds. Useful for quick planning or when only one model is available.

### Iterative Convergence

With 2+ models, the skill runs feedback rounds where each agent sees all other plans and revises their own. Plans typically converge within 2–3 rounds. The skill detects convergence automatically and exits early when all models agree.

### Cost Awareness

The skill calculates and displays estimated premium request usage before starting:

> **Estimated cost:** 3 models × (3 rounds + 1 initial) = **12 premium requests**

### Runtime Compatibility

| Runtime | Model Pool | Detection |
|---------|-----------|-----------|
| **Copilot CLI** | Claude + GPT + Gemini (cross-vendor) | Non-Anthropic models present |
| **Claude Code** | Claude only (cross-tier) | Only Anthropic models present |

The same skill works in both environments. The agent reads its own `task` tool documentation to discover available models at runtime.
