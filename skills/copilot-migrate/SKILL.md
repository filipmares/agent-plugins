---
name: copilot-migrate
description: "Use when migrating, backing up, cloning, or restoring a GitHub Copilot app installation — moving to a new laptop, moving between macOS and Windows, or auditing what Copilot configuration exists locally. Exports settings, skills, MCP config, tool permissions, canvas extension artifacts, saved workflows and chat history into one bundle, then restores it and rewrites the absolute filesystem paths stored in Copilot's databases so projects still resolve on the new machine."
license: MIT
metadata:
  author: filipmares
  version: '1.0.0'
---

# Copilot Migrate

Move a Copilot installation to a new machine without hand-copying files or
losing project wiring.

The hard part is not the copying. Copilot stores **absolute filesystem paths**
in its SQLite databases and in `permissions-config.json`. A plain file copy to a
machine with a different username — or a different OS — leaves every project
pointing at a directory that does not exist. This skill's script rewrites those
paths on import.

## The script

`scripts/copilot_migrate.py`, alongside this file — Python 3.9+, standard
library only, no dependencies. Runs on macOS, Windows and Linux. Each bundle
contains a copy of the script, so the destination machine needs nothing but
Python.

```sh
python3 copilot_migrate.py export  [--out DIR] [--no-history]
python3 copilot_migrate.py inspect BUNDLE
python3 copilot_migrate.py import  BUNDLE [--map OLD=NEW] [--no-rewrite] [--dry-run]
```

On Windows the interpreter is `python`, not `python3`. Windows ships a `python3`
stub that opens the Microsoft Store instead of running anything, so using the
wrong one fails quietly rather than loudly — tell the user to check
`python --version` first.

## Workflow

1. **Export** on the old machine. `--no-history` skips `session-store.db`, which
   is usually the bulk of the bundle, when past conversations are not needed.
2. **Inspect** the bundle. Prints the manifest — workflows, accounts, projects,
   the home-directory prefixes found inside the databases — and suggests a
   `--map` for the current machine. Read-only.
3. **Import** on the new machine, with the Copilot app **fully quit**. Paths are
   remapped automatically from the source home to this machine's home. Anything
   overwritten is copied to `pre-import-backup-<timestamp>/` first.

Use `--dry-run` first when unsure; it reports what would change and writes
nothing.

Set `COPILOT_HOME` to point at a non-default Copilot directory (useful for
testing an import into a scratch directory).

## What travels

- `settings.json`, `mcp-config.json`, `permissions-config.json`
- `skills/` — symlinked skills are resolved to real files
- `automation/` — personal scripts and their SQLite state
- `extensions/<name>/artifacts/` — canvas extension content, such as notes
- `data.db` — projects, workspaces, accounts, saved workflows
- `session-store.db` — chat history, unless `--no-history`

Databases are copied with SQLite's online backup API, so a running app cannot
produce a torn snapshot, and are rolled out of WAL mode so each file is
self-contained and portable.

## What is deliberately left behind

Machine-bound or regenerable, and listed in every bundle's `MANIFEST.md`:

| Excluded | Why |
| --- | --- |
| `config.json`, `m-encryption-key.enc` | machine-bound auth and encryption state |
| `mcp-oauth-config/` | OAuth tokens; re-authenticate instead |
| `installed-plugins/` | reinstall from the marketplaces named in `settings.json` |
| `extensions/<name>/` code | reinstall the extension; only `artifacts/` travel |
| `platform-cache.db`, `embedding-cache.db` | caches that rebuild themselves |
| `session-state/`, `state/`, `logs/`, `chats/`, `workspaces/` | large runtime state |
| `*.bak-*`, `*.pre-update-backup-*` | stale local backups |

Runtime junk is pruned while copying: `node_modules`, `.venv`, `__pycache__`,
`.git`, build output, browser profiles, caches, and any single file over 10 MB.
That last cap matters — a skill symlinked to a folder containing a browser
profile will otherwise drag in gigabytes.

## Path rewriting

These columns hold absolute paths and are rewritten on import:

`projects.main_repo_path`, `worktrees.path`,
`workspace_checkout_bindings.repo_path` / `.checkout_path`,
`workspaces.source_path`, `project_checkouts.root_resource_uri`,
`settings.storage_location`, `app_state.value`, `activity_items.preview`,
`session_open_canvases.payload` — plus every string and **key** in the JSON
config files, since `permissions-config.json` is keyed by directory path.

Separator style follows the target: `C:\Users\me\src\repo` for plain paths,
`file:///C:/Users/me/src/repo` for URIs, forward slashes on POSIX. Paths
containing spaces (`Application Support`, OneDrive folders) are preserved.

Rewriting is prefix-based on the home directory. It does **not** rewrite free
text inside workflow prompts, so check those separately if they hardcode paths;
prompts referring to `~/.copilot` are fine.

## After importing

The script prints these, and they are not optional:

1. Sign in to each GitHub account listed in `MANIFEST.md`.
2. Re-authenticate MCP servers.
3. Reinstall plugins from the marketplaces in `settings.json`.
4. Reinstall canvas extensions, then confirm `artifacts/` survived.
5. Clone repositories to the rewritten paths, or edit `permissions-config.json`
   so its per-directory tool approvals still match. Approvals are path-keyed and
   fail silently when a path no longer matches.
6. Reinstall dependencies for skills that used `node_modules` or a virtualenv.
7. On Windows, `python3` in any migrated automation prompt becomes `python`.

## Auditing without migrating

`export --no-history` followed by `inspect` is a fast way to answer "what is
actually in my Copilot setup?" — the manifest lists skills, workflows and their
schedules, accounts, projects and their paths, and everything excluded.
