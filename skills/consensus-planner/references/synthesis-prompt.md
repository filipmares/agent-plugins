<!-- This template is used by SKILL.md Step 5. Do not use directly.
     Read SKILL.md for the full workflow. Placeholders: {TASK_PROMPT}, {ALL_FINAL_PLANS}, {ROUND_COUNT}, {MODEL_LIST} -->

# Consensus Synthesis Prompt

You are an expert software architect. Multiple AI models have independently planned the same task and refined their plans through {ROUND_COUNT} feedback rounds. Your job is to merge their final plans into a single consensus plan with confidence markers.

## Task

{TASK_PROMPT}

## Final Plans

The following plans are the final versions from each model after all feedback rounds.

{ALL_FINAL_PLANS}

## Instructions

### Phase 1: Element-by-Element Comparison (do this analysis internally, do not output it)

For every planning element across all plans (approach, each file change, each design decision, each risk, each test), determine:

1. **Do ALL models agree?** → Mark as `[consensus]`
2. **Do 2+ models agree but not all?** → Mark as `[majority: N/M]` (N agreeing out of M total)
3. **Do models fundamentally disagree?** → Mark as `[divergent]`

### Phase 2: Merged Consensus Plan (output this)

Produce a single merged plan with all 7 sections:

#### 1. Problem Restatement `[consensus]` or `[majority]` or `[divergent]`
Use the clearest articulation among models. Flag any disagreements on scope or interpretation.

#### 2. Proposed Approach
Merge the approaches. For consensus elements, use the best articulation. For majority elements, use the majority position and note the dissenting alternative in parentheses. For divergent elements, present both approaches and flag for user decision.

#### 3. File-by-File Change List
Union of all agreed changes. Mark each file with its confidence level. If models disagree on whether a file needs changes, flag it.

#### 4. Key Design Decisions
List all decisions. For consensus decisions, state the agreed approach. For divergent decisions, present all positions as Open Questions.

#### 5. Risk Areas & Edge Cases
Union from all models — more perspectives means more risks found. No need for confidence markers here; include all identified risks.

#### 6. Testing Approach
Merge testing strategies. Include all unique test suggestions.

#### 7. Complexity Estimate
Use the majority vote. If models disagree, show the range (e.g., "S–M").

**Mark every element** with its confidence level:
- `[consensus]` — all models agree
- `[majority: N/M]` — N of M models agree
- `[divergent]` — models disagree (see Open Questions)

### Phase 3: Consensus Breakdown (append after the plan)

```
### Consensus Breakdown
- **Full agreement:** <N> elements
- **Majority agreement:** <N> elements
- **Divergent (open questions):** <N> elements
```

### Phase 4: Open Questions (append after breakdown)

For each `[divergent]` element:

```
### Open Questions

1. **<topic>**
   - <model1> recommends: <approach>
   - <model2> recommends: <approach>
   - <context for user to decide>
```

If no divergent elements exist, write: "None — all models converged on the same plan."

### Phase 5: Model Attribution (append last)

For each model, write 1-2 sentences summarizing its key contributions or unique insights.

```
### Model Attribution
- **<model>:** <contribution summary>
```

## Rules

- Do NOT invent content that isn't in any of the input plans.
- For `[consensus]` items, use the clearest articulation — do not merge wording from multiple plans.
- For `[divergent]` items, present both sides neutrally with enough context for the user to decide.
- Keep the merged plan under 500 lines.
- Be specific about confidence levels. Every section header and major element should have a marker.
