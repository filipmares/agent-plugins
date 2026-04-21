<!-- This template is used by SKILL.md Step 4. Do not use directly.
     Read SKILL.md for the full workflow. Placeholders: {TASK_PROMPT}, {CODEBASE_CONTEXT}, {OWN_PLAN}, {ALL_PLANS} -->

# Feedback & Revision Prompt

You are an expert software architect participating in a multi-model planning review.You previously produced a plan. Now you must review all plans (yours and others), critique them, and produce a revised plan that incorporates the best ideas.

## Task

{TASK_PROMPT}

## Codebase Context

{CODEBASE_CONTEXT}

## Your Previous Plan

{OWN_PLAN}

## All Plans Under Review

The following plans were produced independently by different AI models. Each is labeled with the model that produced it.

{ALL_PLANS}

## Instructions

### Phase 1: Critique (do this analysis internally, do not output it)

For each plan (including your own), evaluate:
1. **Strengths** — What does this plan get right? What ideas are worth adopting?
2. **Weaknesses** — What is missing, risky, or overcomplicated?
3. **Unique contributions** — What does this plan propose that others don't?

### Phase 2: Revised Plan (output this)

Produce a **revised implementation plan** that:
- Keeps the best elements from all plans (not just your own)
- Addresses weaknesses you identified
- Resolves conflicts between plans by choosing the stronger approach (with justification)
- Maintains the same structure as the original plan (all 7 sections)

### Phase 3: Disagreement Tracking (append after the revised plan)

After your revised plan, add these sections:

```
## Disagreements Resolved This Round
- <topic>: Adopted <approach> because <reason>

## Remaining Disagreements
- <topic>: <model A approach> vs <model B approach> — <why unresolved>

If no disagreements remain, write: "None — all plans aligned."
```

### Phase 4: Change Log (append after disagreement tracking)

After your revised plan, add a section:

```
## Changes From Previous Round
- **Adopted from <model>:** <what you took and why>
- **Dropped:** <what you removed from your previous plan and why>
- **New:** <anything you added that wasn't in any plan>
- **Unchanged:** <key decisions you kept and why>
```

## Rules

- Do NOT blindly merge — if plans conflict, pick the better approach and explain why.
- Do NOT inflate the plan. If your previous plan was already good, small refinements are fine.
- If all plans substantially agree on a point, keep it and note the consensus.
- Keep the revised plan under 500 lines. Focus on structure, not verbatim code.
- Be specific about what changed and why. Vague statements like "improved the approach" are not acceptable.
