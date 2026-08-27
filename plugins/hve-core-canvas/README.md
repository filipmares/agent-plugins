# HVE-Core Canvas — RPI Artifact Navigator

Experimental, separately opt-in GitHub Copilot plugin that adds one read-only canvas for browsing HVE-Core RPI tracking artifacts.

> **Experimental.** Canvas support is an experimental Copilot surface. This plugin is a pilot and is not bundled into the main HVE-Core plugin.

## What it does

The `rpi-artifact-navigator` canvas renders a read-only view of the Markdown artifacts already on disk in your workspace:

- an artifact index with type, date, task slug, title, and status
- a heading outline for the selected artifact
- the artifact's exact source text, escaped and inert

Files on disk remain the only authoritative state. The canvas is a projection; it never becomes a second source of truth.

## Trust boundary

- **Read-only.** There is no create, edit, delete, rename, or move path. The extension opens files with read-only descriptors and never writes workspace content.
- **Scoped reads.** Only `.md` files under these workspace-relative roots are readable:
  - `.copilot-tracking/research`
  - `.copilot-tracking/plans`
  - `.copilot-tracking/details`
  - `.copilot-tracking/changes`
  - `.copilot-tracking/reviews/plans`
  - `.copilot-tracking/reviews/logs`
- **No escape.** Absolute paths, `..` traversal, sibling-prefix confusion, and symlinked path segments are rejected. Reads are bound to a verified file descriptor with pre-open and post-open identity checks.
- **Loopback only.** The renderer is served from `127.0.0.1` on an ephemeral port behind an unguessable 256-bit per-instance path capability, with `Host`/`Origin` enforcement, CORS denial, a restrictive CSP, and `Cache-Control: no-store`. The capability is invalidated when the canvas closes.
- **No network, no commands, no dependencies.** The extension uses only the Node standard library and the Copilot SDK. It makes no outbound network calls, runs no commands, and emits no telemetry.

## Resource limits

Limits fail explicitly rather than silently truncating content.

| Limit | Value |
|-------|-------|
| Indexed artifacts | 200 |
| Artifact file size | 1 MiB |
| Headings per artifact | 500 |
| Serialized action or HTTP response | 1.5 MiB |

## Agent actions

The canvas exposes exactly three read-only actions. Each returns a raw JSON-compatible value.

| Action | Input | Output |
|--------|-------|--------|
| `list_rpi_artifacts` | `{}` | `{ artifacts, count }` |
| `get_rpi_artifact` | `{ artifactId }` | `{ artifact }` |
| `refresh_rpi_artifacts` | `{}` | `{ artifacts, count, refreshedInstances }` |

`artifactId` is the normalized workspace-relative path, which is the artifact's durable identity. Lists are sorted by `id` ascending. Errors use a closed code set: `workspace_unavailable`, `canvas_unsupported`, `artifact_id_invalid`, `artifact_not_allowed`, `artifact_not_found`, `artifact_not_file`, `artifact_changed`, `artifact_limit_exceeded`, `artifact_too_large`, `heading_limit_exceeded`, `response_too_large`, `request_unauthorized`, `request_invalid`, `server_closed`.

## Supported configurations

Support claims are limited to the combinations actually verified for this pilot.

| Surface | Platform | Host | Assistive technology | Themes |
|---------|----------|------|----------------------|--------|
| Plugin lifecycle and provider RPC | macOS | GitHub Copilot CLI 1.0.80 | n/a | n/a |
| Rendered canvas | macOS | GitHub Copilot CLI 1.0.80 host-reported embedded browser | VoiceOver | Light and dark |

Windows, Linux, IDE-only surfaces, other Copilot versions, and other browser or assistive-technology combinations are **untested and unsupported** during the pilot.

### Verified accessibility behavior

The following was verified in a Chromium rendering engine against a live navigator instance, in both light and dark themes, across the loading, empty, artifact-list, selected-artifact, heading-outline, refresh, and error states:

- keyboard-only operation, with the skip link first in tab order and DOM-ordered focus
- a 3px visible focus indicator on every focusable control
- an accessibility tree exposing `banner`, `navigation`, `region`, `heading`, `list`, `listitem`, `button`, `link`, and `status` roles, with an accessible name on every control
- a polite live region announcing loading, count, selection, refresh, and error states
- outline entries announcing their heading level, and the selected artifact exposed as `aria-current`
- text contrast of at least 9.7:1 for every sampled foreground/background pair, with error text also distinguished by weight rather than colour alone
- no horizontal overflow at a 200% zoom equivalent, single-column reflow at 320 CSS pixels, and no loss of content or function under the WCAG 1.4.12 text-spacing override
- animations and transitions suppressed under `prefers-reduced-motion: reduce`

VoiceOver announcement verification on the host's embedded browser is a manual step and is not covered by the automated evidence above.

## Install

```bash
copilot plugin marketplace add filipmares/agent-plugins
copilot plugin install hve-core-canvas@agent-plugins
```

Verify:

```bash
copilot plugin list
```

## Update, disable, and remove

```bash
# Update to the latest published version
copilot plugin update hve-core-canvas

# Remove completely
copilot plugin uninstall hve-core-canvas
copilot plugin marketplace remove agent-plugins
```

To disable the plugin without uninstalling it, set its entry to `false` under `enabledPlugins` in your Copilot `settings.json`:

```json
{
  "enabledPlugins": {
    "hve-core-canvas@agent-plugins": false
  }
}
```

`copilot plugin list` then reports the plugin as `[disabled]`. There is no `copilot plugin disable` subcommand in the verified CLI version.

## Fallback on unsupported hosts

If the host does not report canvas capability, or no workspace path is available, opening the canvas fails with an explicit `canvas_unsupported` or `workspace_unavailable` error instead of degrading silently. Your normal file and chat workflow is unaffected: the artifacts are ordinary Markdown and remain fully usable without this plugin.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `canvas_unsupported` | Host does not expose canvas rendering | Use a supported GitHub Copilot version, or work with the Markdown files directly |
| `workspace_unavailable` | No workspace path reported by the session | Open Copilot from inside your repository |
| Empty artifact list | No `.copilot-tracking` Markdown in the workspace | Expected; the index is empty rather than an error |
| `artifact_not_allowed` | Path outside the approved roots | Only the roots listed above are readable |
| `artifact_changed` | File was replaced between check and read | Refresh and retry |
| `artifact_too_large` / `artifact_limit_exceeded` | Content exceeds a documented limit | Split the artifact or read it directly |

## Promotion criteria

This pilot stays a separate companion plugin. Bundling into the main HVE-Core plugin is explicitly out of scope until separately defined success and stability gates are agreed and met.

## License

MIT. See [LICENSE](LICENSE).
