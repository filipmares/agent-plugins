# Changelog

## 1.1.0

### Hardening: Prevent agents from skipping the skill protocol

**Problem:** When the plan skill was invoked, agents would read the reference templates but skip SKILL.md entirely — improvising model selection, skipping feedback rounds, and producing free-form output instead of the structured consensus report.

**Changes:**

- **Added Rules section** at the top of SKILL.md with explicit DO NOT guardrails (e.g., do not select models without asking the user, do not skip cost estimate)
- **Added Step 0: Verify Skill Loaded** — agent must display a confirmation message and progress checklist before proceeding, proving SKILL.md is in context
- **Added progress checklist** — visible `☐`/`▶`/`☑` tracker updated at each step to keep agent and user aligned
- **Reordered Step 1** — model discovery is now substep 1a (before task prompt and codebase gathering), anchoring the workflow in concrete runtime data immediately
- **Added header comments to reference templates** — `planning-prompt.md` and `feedback-prompt.md` now include HTML comments pointing back to SKILL.md, preventing the failure mode where agents read templates but not the orchestration instructions

## 1.0.0

- Initial release with 6-step consensus planning workflow
- Multi-model parallel planning with iterative feedback rounds
- Convergence detection and consensus synthesis with confidence markers
- Support for both Copilot CLI (cross-vendor) and Claude Code (cross-tier) runtimes
