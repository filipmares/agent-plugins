# Changelog

## 1.2.0

### Prompt quality, convergence, and reliability improvements

**Changes:**

- **Context exclusion patterns** — Step 1d now excludes `node_modules`, `dist`, `build`, `.next`, `vendor`, `__pycache__`, and other non-source directories/files from the glob, preventing wasted context slots
- **Fixed-format output fields** — Planning prompt now requires `**Complexity: S | M | L**` and `**Files changed: <N>**` for reliable summary extraction and convergence checks
- **Explicit Assumptions section** — Planning prompt requires a dedicated Assumptions subsection, surfacing implicit assumptions that cause plan divergence
- **Multi-step model selection** — Step 2 uses an iterative `ask_user` loop to work within the single-select constraint, fixing a functional limitation
- **Agent failure retry** — Steps 3 and 4 now retry failed agents once before falling back, improving resilience against transient API failures
- **Output structure validation** — Step 3 validates that all 7 required sections are present in agent output, with a single retry for missing sections
- **Disagreement ledger** — Feedback prompt now includes structured "Disagreements Resolved" and "Remaining Disagreements" sections, replacing vague convergence heuristics with agent-reported data
- **Synthesis prompt template** — Created `references/synthesis-prompt.md` for Step 5, matching the template pattern of Steps 3 and 4. The most critical step now has a dedicated, structured template instead of inline prose

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
