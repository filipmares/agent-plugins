---
version: 1
slug: "extensions-rpi-artifact-navigator-renderer-mjs"
primary_target: "extensions/rpi-artifact-navigator/renderer.mjs"
related_targets: ["extensions/rpi-artifact-navigator/server.mjs"]
---

## Scope and mode

The RPI Artifact Navigator canvas panel (`extensions/rpi-artifact-navigator/renderer.mjs`) — the only UI in this repository. Visitor mode: **Operate**.

## Audience, job, action

An engineer supervising an agent that is mid-RPI-loop. They are not authoring; they are checking what the agent just wrote, which task and phase it belongs to, and whether the plan still matches the work. The panel opens itself when an artifact is created and refreshes without stealing focus, so the visitor arrives already mid-task and often mid-scroll.

The three jobs, in frequency order: (1) see what just changed, (2) read one artifact end to end, (3) find an older artifact for a given task.

## Constraints

- CSP forbids images, web fonts, remote assets, inline script and style, `data:` URLs. The entire look comes from system font stacks, color, and CSS.
- The canvas panel is often narrow. Narrow is the common case, not the fallback. Below 40rem the index and the document are two views, not two panes: showing a truncated list above a truncated document serves neither.
- `pre#source` holds exactly one text node (`textContent = doc.source`). No line-number gutter, no syntax highlighting, no markup inside it — the test suite asserts it.
- Read-only. No control may imply a write.

## Chosen direction

The user pinned the world: this must read as native GitHub Copilot app chrome, neutral and unobtrusive, sitting alongside GitHub Primer surfaces. Convention is the commitment — Primer executed at full fidelity, not a quirky reading of it. Restrained color: Primer neutrals plus one accent, accent reserved for selection, focus, and change.

## Memorable moment

**The change ledger.** The panel knows which artifacts the agent touched since the last poll, because it holds the previous `modifiedAt` for every id. Changed rows get a persistent accent marker that survives until the visitor opens them, plus one authored settle animation on refresh. That is the panel's only motion and the one thing no plain file tree gives this visitor.

There is deliberately no heading outline. The visitor reads the artifact whole, and a parallel outline pane spent width without earning it.

## Unresolved

- Clipboard write inside the canvas iframe may be blocked by permissions policy; the copy control falls back to selecting the path and saying so.
