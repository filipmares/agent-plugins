---
name: analyze
description: "Use when analyzing a plugin with multiple AI models to find improvements. Launches parallel model agents, synthesizes consensus, detects duplicate issues, and optionally creates GitHub issues. Trigger on requests like 'analyze the <plugin> plugin' or 'review <plugin> for improvements'."
---

# Multi-Model Plugin Analyzer

Analyze a plugin using multiple AI models in parallel, synthesize consensus findings, and optionally create GitHub issues. Follow these steps in order. Do not skip steps.

---

## Step 1: Setup & Validation

Ask the user which plugin to analyze. Accept a path (e.g., `plugins/cli-skill-generator`) or a plugin name to search for.

**Validate the plugin exists:**

Use `glob` to find the plugin directory, then `view` to verify `.claude-plugin/plugin.json` exists:

```
<plugin-path>/.claude-plugin/plugin.json
```

**If the plugin is NOT found:** Stop immediately. Tell the user:
> The path `<plugin-path>` does not contain a valid plugin (no `.claude-plugin/plugin.json` found).

**If found:** Read the plugin name from `plugin.json` and store it as `PLUGIN_NAME`.

**Read all plugin files:**

Use `glob` to discover all files in the plugin directory:

```
<plugin-path>/**/*
```

Then use `view` to read every file. Store the concatenated contents as `PLUGIN_FILES` — this is the input for the analysis prompt. Include the relative file path as a header before each file's contents.

**Detect the GitHub repository:**

Run via shell:
```
git remote get-url origin
```

Parse the owner and repo name (e.g., `filipmares/agent-plugins`). Store as `REPO_OWNER` and `REPO_NAME`. These are needed for issue creation and duplicate detection.

**Verify GitHub CLI:**

Run via shell:
```
gh auth status
```

If not authenticated, tell the user:
> The `gh` CLI is not authenticated. Run `gh auth login` first, then re-run this skill.

**Discover available models:**

Read your own `task` tool documentation. Look at the `model` parameter description — it lists all available model names. Extract every model name from that list. Store as `AVAILABLE_MODELS`.

**Identify runtime:**
- If `AVAILABLE_MODELS` contains any non-Anthropic models (names starting with `gpt-` or `gemini-`) → runtime is **Copilot CLI**
- If `AVAILABLE_MODELS` contains only Anthropic models (names starting with `claude-`) → runtime is **Claude Code**

Store as `RUNTIME`. Inform the user:
> Detected runtime: <RUNTIME>. Found <count> available models.

---

## Step 2: Configure Analysis Models

Ask the user to select which models to use for analysis via the `ask_user` tool.

**Present all models from `AVAILABLE_MODELS` as choices.** Do not hardcode any model names — use the dynamically discovered list from Step 1.

Rules:
- No defaults — user must explicitly choose
- Minimum 1 model (single-model analysis, no consensus)
- Maximum 5 models
- If user selects more than 5, explain the constraint and ask again

For **Copilot CLI**, suggest picking models from different vendors for maximum diversity (e.g., one Claude + one GPT).

For **Claude Code**, suggest picking models from different tiers for diversity (e.g., Opus + Sonnet or Opus + Haiku).

Store selected models as `SELECTED_MODELS`.

**Ask about dry-run mode:**

Use `ask_user` with choices:
- "Full run — analyze and create GitHub issues"
- "Dry run — analyze only, no issue creation"

Store the choice as `DRY_RUN` (true/false).

---

## Step 3: Parallel Multi-Model Analysis

Read the analysis prompt template from `references/analysis-prompt.md` (relative to this SKILL.md file).

Replace the `{PLUGIN_FILES}` placeholder with the actual `PLUGIN_FILES` content from Step 1.

**Launch parallel analysis agents:**

For each model in `SELECTED_MODELS`, use the `task` tool with:
- `agent_type`: `"general-purpose"`
- `model`: the model name
- `mode`: `"background"` (so agents run in parallel)
- `prompt`: the complete analysis prompt with plugin files inlined

Launch ALL agents simultaneously in a single response (parallel tool calls).

**Wait for all agents to complete:**

Use `read_agent` with `wait: true` for each agent. Collect all responses. If any agent fails, note the failure and continue with the remaining results — partial analysis is still valuable.

Store all model outputs as `MODEL_RESULTS` (a map of model name → findings list).

---

## Step 4: Consensus Synthesis

**If only 1 model was used:** Skip consensus categorization. Present all findings directly as the analysis report — there is no consensus or disagreement with a single model. Proceed to Step 5 (or end if dry-run).

**If 2+ models were used:** Compare all entries in `MODEL_RESULTS` and categorize every finding:

### Consensus (highest priority)
Issues flagged by 2 or more models independently. These are the most reliable findings. Merge overlapping descriptions into a single canonical finding.

### Single-Model Findings (lower priority)
Issues flagged by only 1 model. Note which model raised it. These may still be valid but have less confidence.

### Disagreements
Cases where models give conflicting recommendations. Present both perspectives and let the user decide.

**For each finding, produce:**
- **Title**: concise, descriptive
- **Severity**: `bug`, `enhancement`, or `documentation`
- **Affected files**: with line numbers
- **Problem**: detailed description
- **Proposed fix**: actionable recommendation
- **Models**: which models flagged it
- **Consensus level**: "All models", "N of M models", or "Single model (<name>)"

**Present the consensus report to the user:**

```
## Consensus Report for <PLUGIN_NAME>

### Analysis Summary
- Models used: <model1>, <model2>[, ...]
- Runtime: <RUNTIME>
- Total unique findings: <count>
- Consensus findings: <count> (flagged by 2+ models)
- Single-model findings: <count>
- Disagreements: <count>

### Consensus Findings (2+ models agree)
1. <title> [<severity>] — flagged by <models>
   <brief description>
   ...

### Single-Model Findings
1. <title> [<severity>] — flagged by <model>
   <brief description>
   ...

### Disagreements
1. <title> — <model1> says X, <model2> says Y
   ...
```

If `DRY_RUN` is true, proceed to Step 5 (duplicate detection) but skip Steps 6 and 7.

---

## Step 5: Duplicate Detection

For each finding from Step 4, search for existing GitHub issues that might already cover it.

**Search strategy (try in order):**

1. **GitHub MCP `search_issues` tool** (if available — built-in on Copilot CLI):
   ```
   query: "<PLUGIN_NAME> <key terms from finding title>"
   owner: "<REPO_OWNER>"
   repo: "<REPO_NAME>"
   ```

2. **Shell fallback** (if MCP not available or returns errors):
   ```
   gh search issues "<PLUGIN_NAME>: <key terms>" --repo <REPO_OWNER>/<REPO_NAME> --limit 5
   ```

3. **Local fallback** (if search is unavailable):
   ```
   gh issue list --repo <REPO_OWNER>/<REPO_NAME> --search "<key terms>" --limit 10
   ```

**For each potential duplicate found:**

If `DRY_RUN` is true: flag the finding as a potential duplicate in the report (no user prompt needed). Annotate it with the existing issue number.

If `DRY_RUN` is false: use `ask_user` to present the match:

```
Finding: "<finding title>"
Potential duplicate: #<issue-number> "<issue title>"

Skip this finding, or create a new issue anyway?
```

Choices:
- "Skip — this is a duplicate of #<number>"
- "Create anyway — this is different"

Store decisions. Track skipped findings with the existing issue number they duplicate.

If `DRY_RUN` is true, present the annotated report with duplicate flags and stop. Skip Steps 6 and 7.

---

## Step 6: Issue Creation

For each non-duplicate finding, create a GitHub issue.

Read the issue template from `references/issue-template.md` (relative to this SKILL.md file).

**Create issues via shell:**

```
gh issue create --repo <REPO_OWNER>/<REPO_NAME> --title "<PLUGIN_NAME>: <finding title>" --label "<severity>" --body "<formatted body>"
```

Use the template to format the body. Include:
- Summary
- Problem description with file/line references
- Proposed solution
- Affected files
- Context with model attribution and consensus level

Collect the URL of each created issue.

**If `gh issue create` fails** (e.g., label doesn't exist), retry without the `--label` flag.

---

## Step 7: Summary Report

Present the final report:

```
## Analysis Complete: <PLUGIN_NAME>

### Issues Created
<for each created issue>
- #<number>: <title> (<severity>) — <link>
</for each>

### Issues Skipped (Duplicates)
<for each skipped finding>
- "<title>" — duplicate of #<existing-number>
</for each>

### Analysis Stats
- Runtime: <RUNTIME>
- Models used: <model list>
- Total findings: <count>
- Consensus findings: <count>
- Issues created: <count>
- Duplicates skipped: <count>
- Dry run: <yes/no>
```
