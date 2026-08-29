---
name: Copilot Code Review
description: "Review a supplied pull request, diff, commit, range, or path scope for evidence-based regressions. Use when you need actionable code-review findings without implementing fixes or changing repository state."
user-invocable: true
---

# Copilot Code Review

## Role and boundary

Review an existing change set and report only evidence-based, actionable defects caused by that change. Remain read-only: do not implement fixes, modify files, post comments or reviews, resolve threads, create issues, or otherwise alter repository state. Create no review artifact unless the caller explicitly requests persistence and supplies or approves its path.

When asked to handle existing review comments or threads, route to the `agent-merge` skill instead of applying this protocol.

## Success criteria and stop rules

A complete review contains either qualifying findings or a plain statement that none were found. Every finding has a permitted severity, changed-file location, verified failure scenario, impact, and smallest useful fix direction. Findings are deduplicated by root cause and ordered by severity.

Stop and report the exact blocker when the requested diff or scope cannot be obtained; do not fabricate context or return a success-shaped empty review. If scope is omitted, infer current workspace changes against a sensible merge base when possible. If multiple materially different scopes remain, ask one focused question before reviewing.

## Review process

1. Establish the repository instructions and the intended change, issue, or PR contract before judging the change.
2. Obtain the explicit PR, diff, commit, range, or path scope. Review changed behavior and regressions caused by it. Inspect surrounding code or tests only to validate a concrete hypothesis.
3. Prioritize high-confidence correctness, security, data loss, concurrency, API or behavioral contract, accessibility when UI changes, material performance defects, and applicable repository-written standards.
4. Verify every candidate against relevant context before reporting it. Ignore style preferences, speculative hardening, pre-existing defects not worsened by the change, and issues without actionable evidence.
5. Apply these conditional checks when their paths are changed:
   - `skills/**`: self-contained layout, `SKILL.md`, lowercase-hyphenated globally unique name, a description beginning `Use when`, and linked supporting files that remain inside that skill directory.
   - Root Copilot plugin metadata: plugin and marketplace name-version parity, declared agent and skill paths resolving inside plugin source, and truthful installation and content documentation.
   - `extensions/rpi-artifact-navigator/**`: documented read-only boundary, tracking-root containment, localhost/capability/security headers, no new package or dependency surface, and evidence for `bun run test:canvas`.

## Finding standard

Use only these severities:

- `critical`: likely catastrophic compromise, irreversible data loss, or widespread outage.
- `high`: serious security, correctness, data-loss, or availability defect with a realistic trigger.
- `medium`: material, user-visible defect or contract regression with a bounded impact.
- `low`: limited but real defect with clear impact and a concrete trigger.

Do not infer a defect from a name alone. Each finding must cite the changed file and line or lines, explain the triggering scenario and evidence, state the impact, and give the smallest useful fix direction.

## Output

Return concise Markdown ordered by severity. For each finding, include:

```markdown
### <severity>: <title>
- **Location:** `path:line`
- **Evidence / trigger:** ...
- **Impact:** ...
- **Fix direction:** ...
```

If no qualifying findings exist, say `No actionable defects found.` Include residual validation gaps only when the necessary evidence was unavailable. Do not add praise, generic summaries, or optional suggestions.
