---
name: review-loop
description: "Use when the user wants an automated second-opinion code review after each implementation task. Implements the task, then runs Copilot CLI with a cross-vendor model (e.g. Claude Code → Copilot CLI + GPT 5.4, or vice versa) to produce an independent review and addresses the feedback. Cross-platform (macOS, Linux, Windows). Trigger on requests like 'review-loop <task>', 'add a review loop for <task>', or 'implement <task> with a review loop'."
license: MIT
metadata:
  author: filipmares
  version: '1.0.0'
---

# Review Loop

Re-implementation of [hamelsmu/claude-review-loop](https://github.com/hamelsmu/claude-review-loop) as a self-contained skill, with two changes:

1. **Cross-vendor reviewer** — the reviewer always uses a different model vendor than the agent that implemented the task, via the **Copilot CLI** (`copilot`):
   - Task started in **Claude Code** → review with `copilot` CLI using **`gpt-5.4`**
   - Task started in **Copilot CLI** with an **Anthropic** model → review with `copilot` CLI using **`gpt-5.4`**
   - Task started in **Copilot CLI** with a **non-Anthropic** model (e.g. GPT or Gemini) → review with `copilot` CLI using an **Anthropic** model (e.g. `claude-sonnet-4.5`)
2. **Cross-platform** — works on macOS, Linux, **and Windows**. All shell snippets are given in both POSIX (`bash`/`zsh`) and PowerShell forms, and no POSIX-only tools are required (no `jq`, no symlinks).

The skill creates a two-phase lifecycle around any implementation task:

1. **Task phase** — the user describes a task; this agent implements it.
2. **Review phase** — when the implementation is complete, this agent invokes the Copilot CLI with the cross-vendor reviewer model, streams its output to the user, then reads the resulting review file and addresses the items it agrees with.

Follow the steps below in order. Do not skip steps.

---

## Rules

- **DO NOT** review your own changes with the same model that implemented them — the whole point is an independent second opinion.
- **DO NOT** silently accept or apply every reviewer suggestion. Use judgement: address what you agree with, push back briefly on what you do not.
- **DO NOT** edit the saved review file at `reviews/review-<id>.md`; it is the audit trail.
- **DO NOT** assume `bash`/`jq` is available. Detect the platform and use the appropriate command form.
- **DO NOT** proceed to the review phase until the task implementation actually compiles / lints / tests cleanly to the same standard you would normally hand back to the user.

---

## Step 0: Verify Skill Loaded

Display to the user:

> 🔁 **Review-loop skill loaded.** Starting setup...

Then display the progress checklist:

> ▶ Step 0: Skill Loaded
> ☐ Step 1: Detect runtime & pick reviewer model
> ☐ Step 2: Verify Copilot CLI is installed
> ☐ Step 3: Capture task & prepare state
> ☐ Step 4: Task phase — implement
> ☐ Step 5: Review phase — run Copilot CLI reviewer
> ☐ Step 6: Address review feedback
> ☐ Step 7: Final report

At the start of each subsequent step, redisplay this checklist with the current step marked `▶`, completed steps marked `☑`, and pending steps marked `☐`.

---

## Step 1: Detect Runtime and Pick the Reviewer Model

**1a: Discover available models.**

Read your own `task` tool documentation. The `model` parameter description lists every model name that this runtime can spawn. Extract every model name and store as `AVAILABLE_MODELS`.

**1b: Identify the runtime.**

- If `AVAILABLE_MODELS` contains any non-Anthropic models (names starting with `gpt-` or `gemini-`) → `RUNTIME` = **Copilot CLI**
- Otherwise (only `claude-*` models) → `RUNTIME` = **Claude Code**

**1c: Identify the model that is implementing the task.**

- On **Claude Code**, the implementing model is always Anthropic — set `TASK_VENDOR` = `anthropic`.
- On **Copilot CLI**, ask the user (single short prompt) which model is currently driving the session. Offer the visible Copilot models (Anthropic, OpenAI, Google) as choices. From their answer:
  - name starts with `claude-` → `TASK_VENDOR` = `anthropic`
  - name starts with `gpt-` → `TASK_VENDOR` = `openai`
  - name starts with `gemini-` → `TASK_VENDOR` = `google`

**1d: Choose the cross-vendor reviewer model.**

Apply this table:

| `RUNTIME`     | `TASK_VENDOR` | `REVIEWER_MODEL`                    |
| ------------- | ------------- | ----------------------------------- |
| Claude Code   | anthropic     | `gpt-5.4`                           |
| Copilot CLI   | anthropic     | `gpt-5.4`                           |
| Copilot CLI   | openai        | `claude-sonnet-4.5` (Anthropic)     |
| Copilot CLI   | google        | `claude-sonnet-4.5` (Anthropic)     |

If the chosen `REVIEWER_MODEL` is not actually offered by the local Copilot CLI install (see Step 2), ask the user to pick the closest available cross-vendor model and use that instead.

Tell the user:

> Detected runtime: **<RUNTIME>** · task model vendor: **<TASK_VENDOR>** · reviewer: **Copilot CLI + `<REVIEWER_MODEL>`**

---

## Step 2: Verify Copilot CLI Is Installed

The reviewer is always invoked through the [GitHub Copilot CLI](https://github.com/github/copilot-cli) — binary name `copilot`.

**2a: Detect the platform.** Determine whether the agent's shell environment is Windows or POSIX:

- POSIX (macOS / Linux / WSL): use the `bash` snippets below.
- Windows (native PowerShell / `cmd`): use the `pwsh` snippets below.

Store the choice as `PLATFORM` (`posix` or `windows`).

**2b: Check that `copilot` is on `PATH`.**

```bash
# POSIX
command -v copilot
```

```pwsh
# Windows (PowerShell)
Get-Command copilot -ErrorAction SilentlyContinue
```

**If not found:** stop and tell the user:

> The `copilot` CLI is not installed or not on `PATH`. Install it with `npm install -g @github/copilot` (and on Windows make sure the npm global bin folder is on `PATH`), then re-run `/review-loop`.

**2c: Confirm the reviewer model is available.** Probe the Copilot CLI's model list (the exact flag may evolve; try `--list-models` first, then `--help`):

```bash
copilot --list-models 2>/dev/null || copilot --help
```

```pwsh
copilot --list-models 2>$null; if ($LASTEXITCODE -ne 0) { copilot --help }
```

If `REVIEWER_MODEL` is not present in the output, fall back to Step 1d's negotiation.

---

## Step 3: Capture the Task and Prepare State

**3a: Capture the task.** If the user already supplied a task description when invoking this skill (e.g. `review-loop Add JWT auth`), use it. Otherwise ask:

> What task or feature do you want to implement under the review loop? Describe it in as much detail as you can.

Store as `TASK_PROMPT`.

**3b: Generate a review id.** Pick a short, sortable id `REVIEW_ID` of the form `YYYYMMDD-HHMMSS` based on the current local time. The agent should format this string itself from its own clock; do not depend on `date +%s` (POSIX-only) or `Get-Date` (PowerShell-only) so the same instructions work on every platform. Example: `20260421-053827`.

**3c: Prepare the review output directory.** Ensure a `reviews/` directory exists at the project root, and that it is git-ignored.

```bash
# POSIX
mkdir -p reviews
grep -qxF 'reviews/' .gitignore 2>/dev/null || echo 'reviews/' >> .gitignore
```

```pwsh
# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path reviews | Out-Null
$gi = '.gitignore'
if (-not (Test-Path $gi) -or -not (Select-String -Path $gi -SimpleMatch -Quiet 'reviews/')) {
  Add-Content -Path $gi -Value 'reviews/'
}
```

**3d: Record session state.** Write a small state file at `.copilot-review-loop.local.md` (also git-ignored) containing:

```
phase: task
review_id: <REVIEW_ID>
runtime: <RUNTIME>
task_vendor: <TASK_VENDOR>
reviewer_model: <REVIEWER_MODEL>
task: |
  <TASK_PROMPT>
```

Add it to `.gitignore` the same way as `reviews/` above.

---

## Step 4: Task Phase — Implement the Task

Implement `TASK_PROMPT` using your normal tools. Treat the implementation as if there were no review loop: write tests, run linters/builds, and only consider it "done" when it would pass your usual definition of done.

When the implementation is complete, update the state file's `phase:` value to `addressing`, then continue to Step 5.

---

## Step 5: Review Phase — Run Copilot CLI Reviewer

**5a: Build the review prompt.** Read [`references/review-prompt.md`](references/review-prompt.md) and substitute:

- `{TASK_PROMPT}` → the user's task description
- `{REVIEWER_MODEL}` → the chosen `REVIEWER_MODEL`
- `{REVIEW_FILE}` → `reviews/review-<REVIEW_ID>.md`

Save the filled prompt to a temp file:

```bash
# POSIX
PROMPT_FILE="$(mktemp -t review-loop.XXXXXX.md)"
# write the filled prompt to "$PROMPT_FILE"
```

```pwsh
# Windows (PowerShell)
$PromptFile = Join-Path $env:TEMP ("review-loop-{0}.md" -f ([guid]::NewGuid()))
# write the filled prompt to $PromptFile
```

**5b: Decide which extra reviewer agents apply.** The reviewer always runs at minimum:

- **Diff Review** — `git diff` against the merge-base with the default branch; focus on code quality, test coverage, and security (OWASP top 10).
- **Holistic Review** — project structure, documentation, `AGENTS.md`/`CLAUDE.md`, architecture.

Conditionally also include:

- **Web framework review** — if `package.json` contains `"next"`, or any `next.config.*` / `nuxt.config.*` / `vite.config.*` / `astro.config.*` file exists, include framework-specific review (App Router / SSR / caching / Server Actions / hydration / performance).
- **UX review** — if `app/`, `pages/`, `public/`, or `index.html` exists, include accessibility, responsive layout, and basic E2E checks.

The selected agent list is part of the review prompt the reviewer is asked to follow.

**5c: Invoke the Copilot CLI reviewer.** Stream the output so the user can watch the review happen in real time. The `copilot` CLI accepts a model flag and a prompt file (the exact flag may be `--model`/`-m` and `--prompt-file`/`-p`; consult `copilot --help` once at the start of Step 2 and reuse the verified form).

```bash
# POSIX
copilot --model "$REVIEWER_MODEL" --prompt-file "$PROMPT_FILE"
```

```pwsh
# Windows (PowerShell)
copilot --model $env:REVIEWER_MODEL --prompt-file $PromptFile
```

The prompt instructs the reviewer to write its consolidated findings to `reviews/review-<REVIEW_ID>.md`. If the reviewer instead emits the review to stdout, capture stdout and write it to that path yourself:

```bash
# POSIX (fallback)
copilot --model "$REVIEWER_MODEL" --prompt-file "$PROMPT_FILE" \
  | tee "reviews/review-$REVIEW_ID.md"
```

```pwsh
# Windows (PowerShell, fallback)
copilot --model $env:REVIEWER_MODEL --prompt-file $PromptFile `
  | Tee-Object -FilePath ("reviews/review-{0}.md" -f $env:REVIEW_ID)
```

If `copilot` exits non-zero, retry once. If it fails again, stop and report the error to the user — do not silently mark the loop as complete.

**5d: Clean up the temp prompt file.**

```bash
# POSIX
rm -f "$PROMPT_FILE"
```

```pwsh
# Windows
Remove-Item -Force $PromptFile -ErrorAction SilentlyContinue
```

---

## Step 6: Address Review Feedback

Read `reviews/review-<REVIEW_ID>.md`. For each finding:

1. Decide: **Agree → fix now**, **Disagree → note why**, or **Out of scope → defer**.
2. For "fix now" items, apply the change and re-run the relevant lint/test/build.
3. Append a short addressed-items section to the review file under a `## Addressed` heading, e.g.:

   ```markdown
   ## Addressed (by implementing agent)
   - ✅ Fixed null-check in `src/foo.ts` (matches reviewer finding #2).
   - ❌ Reviewer finding #4 — disagreed: <one-sentence reason>.
   - ⏭ Reviewer finding #6 — deferred: out of scope for this task.
   ```

When all items have a disposition, update the state file's `phase:` to `done` (or delete the state file) and continue to Step 7.

---

## Step 7: Final Report

Present a short summary to the user:

```
✅ Review loop complete

Task:           <one-line task summary>
Runtime:        <RUNTIME>
Task vendor:    <TASK_VENDOR>
Reviewer:       Copilot CLI + <REVIEWER_MODEL>
Review file:    reviews/review-<REVIEW_ID>.md
Findings:       <N total> — <X fixed>, <Y disagreed>, <Z deferred>
```

Then stop. The user can inspect `reviews/review-<REVIEW_ID>.md` for the full audit trail and ask follow-up questions.

---

## Cancelling

If the user asks to cancel mid-loop (e.g. `cancel review-loop`):

1. Delete `.copilot-review-loop.local.md`.
2. Leave the partially-implemented changes and any partial review file in place — do **not** revert their work.
3. Tell the user: *"Review loop cancelled. Implementation changes and any partial review file at `reviews/review-<REVIEW_ID>.md` were left untouched."*
