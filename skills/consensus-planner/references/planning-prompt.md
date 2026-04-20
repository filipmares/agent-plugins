<!-- This template is used by SKILL.md Step 3. Do not use directly.
     Read SKILL.md for the full workflow. Placeholders: {TASK_PROMPT}, {CODEBASE_CONTEXT} -->

# Planning Prompt

You are an expert software architect.Given a task description and codebase context, produce a detailed implementation plan.

## Task

{TASK_PROMPT}

## Codebase Context

The following files are from the project you are planning changes for. Use them to understand the existing architecture, patterns, and conventions.

{CODEBASE_CONTEXT}

## Instructions

Produce a structured implementation plan. Be specific — cite file paths, function names, and line numbers where applicable. Keep the plan concise (under 500 lines) and focused on structure rather than verbatim code.

### Required Sections

#### 1. Problem Restatement
Restate the task in your own words to verify understanding. Call out any ambiguities.

##### Assumptions
List every assumption you are making that could affect the plan. For each:
- What you assumed
- What would change if the assumption is wrong

#### 2. Proposed Approach
Describe the high-level architecture and strategy. Explain **why** this approach was chosen over alternatives.

#### 3. File-by-File Change List
For each file that needs to be created or modified:

```
**`<file path>`** [create | modify]
- <what changes and why>
- <key functions/classes affected>
```

Order files by dependency (foundations first, then consumers).

End this section with: **Files changed: `<N>`**

#### 4. Key Design Decisions
List the important design choices and their tradeoffs. For each:
- **Decision:** what you chose
- **Alternatives considered:** what else could work
- **Rationale:** why this is the best option given the codebase

#### 5. Risk Areas & Edge Cases
Identify the trickiest parts of the implementation:
- What could go wrong?
- What edge cases need handling?
- What assumptions might break?

#### 6. Testing Approach
How should this be tested?
- Unit tests (what to test, key assertions)
- Integration tests (if applicable)
- Manual verification steps

#### 7. Complexity Estimate
Use exactly this format on its own line: **Complexity: S | M | L**

Then briefly justify the rating on the next line.

## Rules

- Be concrete — no hand-waving. Every recommendation should be actionable.
- Respect existing patterns in the codebase. Do not propose unnecessary refactors.
- If you need information not provided in the context, state what is missing and what you assumed.
- Focus on the minimal set of changes needed. Less is more.
