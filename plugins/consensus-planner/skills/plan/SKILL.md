---
name: plan
description: "Use when creating an implementation plan using multiple AI models that iterate toward consensus. Spawns parallel agents with user-selected models to independently plan, exchange feedback, and converge. Trigger on requests like 'consensus plan for <task>' or 'multi-model plan for <feature>'."
---

# Multi-Model Consensus Planner

**CRITICAL: Read this entire SKILL.md before taking any action. Follow each numbered step exactly. Do NOT improvise the workflow.**

Create an implementation plan by spawning multiple AI agents (each using a different model), running iterative feedback rounds, and synthesizing a consensus plan. Follow these steps in order. Do not skip steps.

## Rules

You **MUST** follow the step-by-step protocol below. These rules are non-negotiable:

- **DO NOT** select models without asking the user via `ask_user`
- **DO NOT** skip the cost estimate confirmation in Step 2
- **DO NOT** skip feedback rounds (Step 4) unless only 1 model is selected
- **DO NOT** use your own plan format — use the 7-section template from `references/planning-prompt.md`
- **DO NOT** synthesize without confidence markers (`[consensus]`/`[majority]`/`[divergent]`)
- **DO NOT** launch planning agents (Step 3) without completing Step 2 (Configure) first
- If you find yourself launching agents before the user has selected models and confirmed cost, **STOP** and go back to Step 2

---

## Step 0: Verify Skill Loaded

Before proceeding, confirm you have read this SKILL.md in full. Display to the user:

> 🔧 **Consensus Planner skill loaded.** Starting setup...

Then display the progress checklist:

> ▶ Step 0: Skill Loaded
> ☐ Step 1: Setup & Context
> ☐ Step 2: Configure (models, rounds, cost)
> ☐ Step 3: Initial Planning
> ☐ Step 4: Feedback Rounds
> ☐ Step 5: Consensus Synthesis
> ☐ Step 6: Final Report

**At the start of each subsequent step**, redisplay this checklist with the current step marked `▶`, completed steps marked `☑`, and pending steps marked `☐`. This keeps you and the user aligned on progress.

---

## Step 1: Setup & Context Gathering

**1a: Discover available models (do this FIRST):**

Read your own `task` tool documentation. Look at the `model` parameter description — it lists all available model names. Extract every model name from that list. Store as `AVAILABLE_MODELS`.

**1b: Identify runtime:**
- If `AVAILABLE_MODELS` contains any non-Anthropic models (names starting with `gpt-` or `gemini-`) → runtime is **Copilot CLI**
- If `AVAILABLE_MODELS` contains only Anthropic models (names starting with `claude-`) → runtime is **Claude Code**

Store as `RUNTIME`. Inform the user:
> Detected runtime: **<RUNTIME>**. Found **<count>** available models.

**1c: Get the task prompt:**

If the user already provided a task description when invoking this skill, use it. Otherwise, ask via `ask_user`:

> What task or feature do you want to plan? Describe it in as much detail as possible.

Store as `TASK_PROMPT`.

**1d: Gather codebase context:**

Use `glob` to discover the project structure:

```
**/*.{ts,js,tsx,jsx,py,rs,go,java,cs,md,json,yaml,yml,toml}
```

Exclude common non-source directories and generated files from results:
- **Directories:** `node_modules`, `dist`, `build`, `.next`, `out`, `target`, `vendor`, `__pycache__`, `.git`, `coverage`, `.cache`
- **Files:** `*.min.js`, `*.map`, `*.lock`, `*.snap`

If the project has a `.gitignore`, use it as additional exclusion guidance.

Identify the most relevant files using these heuristics (in priority order):
1. README, CONTRIBUTING, or architecture docs at the repo root
2. Package manifests (package.json, Cargo.toml, go.mod, pyproject.toml, *.csproj, etc.)
3. Entry points and main source files
4. Files whose names or paths relate to keywords in `TASK_PROMPT`
5. Configuration files (.env.example, tsconfig.json, etc.)

Use `view` to read up to 10 of the most relevant files. Concatenate their contents with file path headers as `CODEBASE_CONTEXT`:

```
### <relative-file-path>
<file contents>
```

If the project has more than 200 files, tell the user which files you selected and ask if they want to add or replace any.

---

## Step 2: Configure

**Model selection:**

Since `ask_user` is single-select, use an iterative loop to collect 1–5 models:

1. Present all `AVAILABLE_MODELS` as choices → user picks first model
2. Show remaining models plus a "Done selecting" option → user picks another or finishes
3. Repeat until the user selects "Done" or 5 models are reached

At each step, show which models are already selected. Recommend 2 models as a good default for cost/diversity balance:
- For **Copilot CLI**, recommend picking models from different vendors (e.g., one Claude + one GPT + one Gemini)
- For **Claude Code**, recommend picking models from different tiers (e.g., Opus + Sonnet)

Store as `SELECTED_MODELS`.

**If only 1 model selected:** Inform the user that iterative feedback requires 2+ models. Ask:
- "Continue with single-model planning (no feedback rounds)"
- "Go back and select more models"

If single-model: skip to Step 3, produce one plan, skip Steps 4-5, go directly to Step 6 with that plan.

**Max feedback rounds:**

Ask via `ask_user` with choices:
- "2 rounds (fast)"
- "3 rounds (Recommended)"
- "5 rounds (thorough)"

Store the number as `MAX_ROUNDS`.

**Cost estimate:**

Calculate and display:
> **Estimated cost:** <SELECTED_MODELS count> models × (<MAX_ROUNDS> feedback rounds + 1 initial) = **<total> premium requests**
>
> Proceed?

Use `ask_user` with choices:
- "Yes, proceed"
- "Adjust configuration"

If "Adjust," loop back to model selection.

---

## Step 3: Parallel Initial Planning

Read the planning prompt template from `references/planning-prompt.md` (relative to this SKILL.md file).

Replace placeholders:
- `{TASK_PROMPT}` → the user's task description
- `{CODEBASE_CONTEXT}` → the gathered codebase context

**Launch parallel planning agents:**

For each model in `SELECTED_MODELS`, use the `task` tool with:
- `agent_type`: `"general-purpose"`
- `model`: the model name
- `mode`: `"background"`
- `prompt`: the complete planning prompt with placeholders filled

Launch ALL agents simultaneously in a single response (parallel tool calls).

**Wait for all agents to complete:**

Use `read_agent` with `wait: true` for each agent. Collect all responses.

If any agent fails, retry it **once** with the same prompt. If the retry also fails, note the failure and continue with remaining results. If all agents fail (including retries), stop and report the error to the user.

Store results as `PLANS` — a map of model name → plan text.

**Validate plan structure:**

For each plan, verify it contains all 7 required section headers: Problem Restatement, Proposed Approach, File-by-File Change List, Key Design Decisions, Risk Areas & Edge Cases, Testing Approach, Complexity Estimate. If any section is missing, retry that agent **once** with: "Your plan is missing sections: [list]. Please regenerate the complete plan with all 7 sections." If the retry also fails, proceed with what was returned and flag missing sections as `[section missing]` in the summary.

**Present summaries:**

For each plan, extract and display:
- Model name
- The "Problem Restatement" section (1-2 sentences)
- The "Proposed Approach" section (first paragraph only)
- Complexity estimate
- Number of files to change

```
### Initial Plans Summary

**<model1>:** <approach summary> | Complexity: <S/M/L> | Files: <N>
**<model2>:** <approach summary> | Complexity: <S/M/L> | Files: <N>
...
```

---

## Step 4: Iterative Feedback Rounds

**If only 1 model was selected:** Skip this step entirely.

Read the feedback prompt template from `references/feedback-prompt.md` (relative to this SKILL.md file).

For each round (1 through `MAX_ROUNDS`):

**4a: Construct feedback prompts**

For each model in `SELECTED_MODELS`, replace placeholders in the feedback template:
- `{TASK_PROMPT}` → the user's task description
- `{CODEBASE_CONTEXT}` → the gathered codebase context
- `{OWN_PLAN}` → this model's plan from the previous round
- `{ALL_PLANS}` → all models' plans from the previous round, each wrapped as:
  ```
  --- Plan by <model name> ---
  <plan text>
  --- End of plan by <model name> ---
  ```

**4b: Launch parallel feedback agents**

For each model, use the `task` tool with:
- `agent_type`: `"general-purpose"`
- `model`: the same model that produced the plan
- `mode`: `"background"`
- `prompt`: the filled feedback prompt

Launch ALL agents simultaneously.

**4c: Collect results**

Use `read_agent` with `wait: true` for each agent. Update `PLANS` with the new revised plans.

If an agent fails in this round, retry it **once** with the same prompt. If the retry also fails, carry forward its plan from the previous round. Note the failure.

**4d: Convergence check**

Read each agent's "Remaining Disagreements" section from this round's output.

- If ALL agents report "None — all plans aligned" → **converged**
- Otherwise, collect the remaining disagreements across all agents

**If converged** (all plans substantially agree on approach, files, and key decisions):
> ✅ **Round <N>/<MAX_ROUNDS> complete — Converged.** All models agree on the approach. Proceeding to synthesis.

Exit the loop. Proceed to Step 5.

**If NOT converged and rounds remain:**
> 🔄 **Round <N>/<MAX_ROUNDS> complete — Key disagreements remain:**
> - <topic 1>: <model A> vs <model B>
> - <topic 2>: ...
>
> Continuing to next round.

Continue the loop.

**If NOT converged and no rounds remain:**
> ⚠️ **Round <MAX_ROUNDS>/<MAX_ROUNDS> complete — Max rounds reached.** Some disagreements remain. Proceeding to synthesis with divergent elements noted.

Proceed to Step 5.

---

## Step 5: Consensus Synthesis

**If only 1 model was used:** Skip this step. Use the single plan directly in Step 6.

Analyze all final-round plans side by side. For every planning element (approach, each file change, each design decision, testing strategy), categorize it:

### Consensus (highest confidence)
Elements where ALL models agree. These form the backbone of the final plan. Use the clearest articulation among the models.

### Majority (high confidence)
Elements where 2+ models agree but not all. Use the majority position. Note the dissenting model's alternative in parentheses.

### Divergent (open questions)
Elements where models fundamentally disagree. Present both/all perspectives and let the user decide.

**Merge into a single consensus plan** following the same 7-section structure from the planning prompt:
1. Problem Restatement (consensus version)
2. Proposed Approach (merged — flag any majority/divergent elements)
3. File-by-File Change List (union of all agreed changes, with confidence markers)
4. Key Design Decisions (consensus decisions + open questions for divergent ones)
5. Risk Areas & Edge Cases (union from all models — more eyes = more risks found)
6. Testing Approach (merged)
7. Complexity Estimate (majority vote or range if disagreed)

Mark each element with its confidence level:
- `[consensus]` — all models agree
- `[majority: N/M]` — N of M models agree
- `[divergent]` — models disagree (see Open Questions)

---

## Step 6: Present Final Report

Present the complete consensus plan to the user:

```
## Consensus Plan: <one-line task summary>

### Configuration
- **Models:** <model1>, <model2>[, ...]
- **Rounds completed:** <N> (<converged at round M> | <reached max>)
- **Runtime:** <Copilot CLI | Claude Code>

### Plan

<the merged consensus plan with all 7 sections, including [consensus]/[majority]/[divergent] markers>

### Consensus Breakdown
- **Full agreement:** <N> elements
- **Majority agreement:** <N> elements
- **Divergent (open questions):** <N> elements

### Open Questions

<if any divergent elements exist, list them>

1. **<topic>**
   - <model1> recommends: <approach>
   - <model2> recommends: <approach>
   - <context for user to decide>

<if no divergent elements>
None — all models converged on the same plan.

### Model Attribution
<for each model>
- **<model>:** <1-2 sentence summary of this model's key contributions or unique insights>
```

**After presenting the report:** Do not take further action. The user can use this plan to guide implementation, ask follow-up questions, or invoke other tools.
