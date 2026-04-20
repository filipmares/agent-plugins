# GitHub Issue Template

Use this template when creating GitHub issues from analysis findings.

## Title Format

```
<plugin-name>: <concise description>
```

## Label

One of: `bug`, `enhancement`, `documentation`

## Body Template

```markdown
## Summary

<one-line summary of the issue>

## Problem

<detailed description of the problem, including file paths and line numbers>

## Proposed Solution

<specific, actionable fix with code or text examples where applicable>

## Affected Files

- `<file-path>` (lines ~X-Y)

## Context

Identified by multi-model analysis using: <model1>, <model2>[, <model3>, <model4>].

<consensus note — one of:>
- "All models flagged this independently"
- "Flagged by <N> of <M> models: <model names>"
- "Flagged by <model> only — single-model finding"
```
