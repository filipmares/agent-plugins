# Notes

Markdown notes for the GitHub Copilot app. **Phase 1 implements storage and
`notes_manage`; the editor UI and plugin registration are not shipped yet.**
Opening the canvas currently returns `notes_editor_pending`, not a placeholder
that pretends editing is available.

## Library and privacy

Notes uses one global library at the operating system's Documents folder under
`Copilot Notes`. Windows redirected/OneDrive Documents and Linux's
`xdg-user-dir DOCUMENTS` are respected; macOS uses `~/Documents`. There is no
runtime folder override. The directory is created lazily on first use.

Each `.md` note has YAML frontmatter containing `id`, `created`, `updated`,
`created_by`, `project`, `branch`, `session_id`, `session_name`, and `sessions`.
Unavailable optional origin fields are omitted. Origin fields stay fixed;
content edits update `updated` and add the editing session to `sessions`.
Pinning uses `pinned: true` without advancing the edit date. Custom fields and
YAML comments are preserved.

Session names, repository names, branches, and local project paths can be
sensitive. Local paths may contain your username. Documents sync services
sync this metadata along with note content. Notes does not send telemetry.
Uninstalling the extension does not delete the library.

Discovery **writes frontmatter to plain Markdown files**, preserving the body
and original modified time. Adopted files have no invented origin; they enter
This Session after editing there. Copied IDs are repaired, with the older
physical file retaining its ID. Malformed YAML, incompatible reserved fields,
and values that cannot safely pass through JSON (such as cyclic aliases or
oversized integers or YAML sets/maps) are exposed as raw Markdown with a warning,
not rewritten. Files whose adoption would exceed the size limit are left intact
and reported individually; they do not prevent access to other notes.

Dot folders, `.assets` folders, non-Markdown files, symlinks, and hard-linked
notes are not indexed. Unsupported files are reported in search warnings.
The library root itself cannot be a symlink or junction.
Only UTF-8 notes up to 8 MiB (including frontmatter) are supported.

Phase 1 rescans on tool calls; the cached index, watcher, and editor conflict
banner belong to later phases. Scanning reads all note files and can hydrate
online-only OneDrive/iCloud files.

## Copilot tool

`notes_manage` is available without opening the canvas:

| Operation | Inputs |
| --- | --- |
| `create` | `body`, optional `folder`; the first line becomes the title |
| `search` | Optional `query`, `project`, `session`, `folder`, `limit`, `offset` |
| `read` | `noteId` (a ULID or library-relative `.md` path) |
| `append` | `noteId`, `text`, `expectedVersion` |
| `update` | `noteId`, `expectedVersion`, and either `body` or `find` + `replace` |
| `delete` | `noteId`, `expectedVersion` |
| `move` | `noteId`, `folder`, `expectedVersion`; empty folder means the root |
| `folders` | No additional inputs |

`read` and `search` return a content `version`. Supply it as `expectedVersion`
for mutations; a stale version produces `conflict`. Find/replace is literal and
requires a unique match unless `replaceAll: true` is supplied. Full replacement
only replaces the body, not server-owned frontmatter. For malformed frontmatter,
`read` returns the complete file as the body with an explicit warning; repair
it in plain Markdown.

Search ignores case and accents and requires every query word. Title matches
rank before body matches, then the later of frontmatter `updated` and file mtime.
Results include a snippet, folder, version, provenance, total count, and
`nextOffset`; the default page size is 50 (maximum 100). A folder filter includes
descendants. Empty queries list recent notes.

Create makes missing folders, sanitizing portable names and reusing existing
folders case-insensitively. Move requires an existing folder. Copilot cannot
rename or delete folders. The storage API includes those user-only operations
for the forthcoming UI; folder deletion requires a separate confirmation.
Folders containing unsafe descendants remain listed with a warning and a null
mutation version; they cannot be renamed or deleted through Notes.

New filenames are lowercase title slugs, up to 40 characters, with collision
suffixes. Automatic renaming stops when the filename no longer matches the
generated title name. Adopted filenames are retained. A note's sibling
`<filename-without-md>.assets` directory follows moves, renames, and deletion;
local Markdown destinations are updated without reserializing the whole body.
Links in other notes are not rewritten.

## Deletion and concurrency

Deletion normally moves items to the OS trash:

- Windows: PowerShell invokes `IFileOperation` with `FOFX_RECYCLEONDELETE`.
  This deliberately replaces the proposed VisualBasic API: the recycle-only
  flag avoids its possible permanent-delete fallback.
- macOS: Finder's trash operation through `osascript`.
- Linux: `gio trash`.

If trash fails, the tool uses `session.ui.confirm`. Anything other than an
explicit `true`, including a host that cannot show the dialog, returns
`trash_unavailable` and keeps the remaining item. Allow-all/autopilot does not
bypass this confirmation. A partial failure identifies items already trashed.
Real OS trash behavior is not claimed verified by the mocked tests.

Writers across sessions serialize through a short-lived `.notes-write.lock`
in the library. Files use same-directory temporary writes, no-clobber publication
for new names, and content-hash checks before replacing existing notes.
The filesystem must support hard links and atomic renames (normal local NTFS,
APFS, and Linux filesystems do). A crashed writer can leave the lock behind;
requests fail with `library_busy` rather than guessing that another writer is
dead. **Only after stopping all Notes processes**, inspect its `pid`/`host` and
remove that exact lock file. Never delete notes to resolve a lock.

External editors do not participate in this lock. Hash checks detect changes
observed before commit; they are not an OS-level compare-and-swap against a
non-cooperating writer. Multi-item note/assets operations are not crash-atomic.
Incomplete rollback reports both paths for recovery instead of deleting the
only remaining copy.

## Development

From the repository root on Windows:

```powershell
bun install --cwd extensions\notes\client --frozen-lockfile --ignore-scripts
bun run build:notes
bun run test:notes
```

Only the maintainer build needs Bun and dependencies. Runtime code is `.mjs`,
Node standard library, the host-resolved Copilot SDK, and committed offline
bundles. Do not install the SDK into this extension.

The Phase 1 build emits `vendor/yaml.mjs` and `vendor/markdown.mjs`.
`vendor/manifest.json` pins bundle/source hashes, package versions, and licence
sources. Verbatim dependency licences live in `third-party-licenses/`.
Git attributes preserve bundle/licence bytes; source fingerprints normalize
text line endings. The stale-bundle test works without `node_modules`.

The default test suite uses isolated temporary libraries and mocked trash.
On Windows it also compiles the recycle helper against a nonexistent target,
without trashing anything. Node subprocess tests exercise races across actual
processes. Setting
`NOTES_TEST_REAL_TRASH=1` opts into moving one test file to your real OS trash.
Do not set it in an unattended routine test run.

The planned editor and interactions are based on
[bholmesdev/hubble.md](https://github.com/bholmesdev/hubble.md) (MIT).
No Hubble editor code is included in Phase 1. Deferred features are tracked in
[issue #60](https://github.com/filipmares/agent-plugins/issues/60).
