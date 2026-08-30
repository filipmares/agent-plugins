/**
 * Read-only navigator renderer.
 *
 * Produces the HTML, CSS, and client script served by `server.mjs`. Artifact
 * text is never interpolated into markup here; the client fetches JSON and
 * assigns it through `textContent`, so hostile Markdown, embedded HTML, and
 * scripts remain inert.
 *
 * The stylesheet and client script are served as separate same-origin
 * resources so the Content-Security-Policy can forbid inline script and style
 * entirely.
 */

const HTML_ESCAPES = Object.freeze({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
});

/** Escape a value for interpolation into HTML text or an attribute value. */
export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export const NAVIGATOR_STYLES = `
:root {
  color-scheme: light dark;
  --surface: #ffffff;
  --surface-raised: #f1f3f5;
  --border: #57606a;
  --text: #10151b;
  --text-muted: #3d454e;
  --accent: #0a4f96;
  --accent-text: #ffffff;
  --focus: #0a4f96;
  --danger: #8b0000;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #0d1117;
    --surface-raised: #171c23;
    --border: #a3adb9;
    --text: #f2f5f8;
    --text-muted: #cbd4de;
    --accent: #79bbff;
    --accent-text: #04101f;
    --focus: #79bbff;
    --danger: #ffa198;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 1rem;
  line-height: 1.5;
  background: var(--surface);
  color: var(--text);
}
.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  padding: 0.5rem 0.75rem;
  background: var(--accent);
  color: var(--accent-text);
  z-index: 10;
}
.skip-link:focus { left: 0.5rem; top: 0.5rem; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.layout {
  display: grid;
  grid-template-columns: minmax(13rem, 20rem) minmax(11rem, 16rem) minmax(0, 1fr);
  gap: 1rem;
  padding: 1rem;
  align-items: start;
}
@media (max-width: 60rem) {
  .layout { grid-template-columns: minmax(0, 1fr); }
}
header.toolbar {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1rem;
  align-items: center;
}
h1 { font-size: 1.25rem; margin: 0; }
h2 { font-size: 1rem; margin: 0 0 0.5rem; }
button {
  font: inherit;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--surface-raised);
  color: var(--text);
  cursor: pointer;
}
section, nav > section {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem;
  background: var(--surface);
  min-width: 0;
}
ul { list-style: none; margin: 0; padding: 0; }
.item {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: none;
  padding: 0.375rem 0.5rem;
  overflow-wrap: anywhere;
}
.item:hover { background: var(--surface-raised); }
.item[aria-current="true"] {
  background: var(--surface-raised);
  border-color: var(--accent);
  font-weight: 600;
}
.item .meta { display: block; font-size: 0.8125rem; color: var(--text-muted); }
.outline-level-2 { padding-left: 0.75rem; }
.outline-level-3 { padding-left: 1.5rem; }
.outline-level-4 { padding-left: 2.25rem; }
.outline-level-5 { padding-left: 3rem; }
.outline-level-6 { padding-left: 3.75rem; }
dl.metadata { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.25rem 0.75rem; margin: 0 0 0.75rem; }
dt { color: var(--text-muted); }
dd { margin: 0; overflow-wrap: anywhere; }
pre.source {
  margin: 0;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--surface-raised);
  max-height: 70vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.875rem;
  tab-size: 4;
}
.status { margin: 0; min-height: 1.5rem; color: var(--text-muted); }
.status[data-tone="error"] { color: var(--danger); font-weight: 600; }
.empty { color: var(--text-muted); padding: 0.375rem 0.5rem; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`;

export const NAVIGATOR_SCRIPT = String.raw`
(function () {
  "use strict";

  // The document is served at the capability base path, so the base is derived
  // from the current location instead of being injected inline. This lets the
  // Content-Security-Policy forbid inline script entirely.
  var base = window.location.pathname.replace(/\/+$/, "");

  var state = { artifacts: [], selectedId: null, document: null, targetRevision: -1 };

  var statusEl = document.getElementById("status");
  var listEl = document.getElementById("artifact-list");
  var outlineEl = document.getElementById("outline-list");
  var metadataEl = document.getElementById("metadata");
  var sourceEl = document.getElementById("source");
  var refreshBtn = document.getElementById("refresh");
  var titleEl = document.getElementById("document-title");

  function setStatus(message, tone) {
    statusEl.textContent = message;
    statusEl.setAttribute("data-tone", tone || "info");
  }

  function request(path, options) {
    var init = Object.assign({ headers: { Accept: "application/json" }, credentials: "omit" }, options || {});
    return fetch(base + path, init).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body && body.message ? body.message : "Request failed");
        return body;
      });
    });
  }

  function describe(artifact) {
    var parts = [];
    if (artifact.type) parts.push(artifact.type);
    if (artifact.date) parts.push(artifact.date);
    if (artifact.status) parts.push("status " + artifact.status);
    return parts.join(" \u00b7 ");
  }

  function renderList() {
    listEl.textContent = "";
    if (state.artifacts.length === 0) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No RPI artifacts were found in the approved tracking roots.";
      listEl.appendChild(empty);
      return;
    }
    state.artifacts.forEach(function (artifact) {
      var li = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "item";
      button.setAttribute("data-artifact-id", artifact.id);
      if (artifact.id === state.selectedId) button.setAttribute("aria-current", "true");

      var label = document.createElement("span");
      label.textContent = artifact.title || artifact.id;
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = describe(artifact);

      button.appendChild(label);
      button.appendChild(meta);
      button.addEventListener("click", function () { select(artifact.id); });
      li.appendChild(button);
      listEl.appendChild(li);
    });
  }

  function renderDocument() {
    outlineEl.textContent = "";
    metadataEl.textContent = "";
    sourceEl.textContent = "";
    var doc = state.document;
    if (!doc) {
      titleEl.textContent = "No artifact selected";
      return;
    }
    titleEl.textContent = doc.title || doc.id;

    [
      ["Path", doc.id],
      ["Type", doc.type],
      ["Date", doc.date || "unknown"],
      ["Task", doc.taskSlug || "unknown"],
      ["Status", doc.status || "unknown"],
      ["Modified", doc.modifiedAt],
      ["Size", doc.sizeBytes + " bytes"],
      ["SHA-256", doc.sha256]
    ].forEach(function (pair) {
      var dt = document.createElement("dt");
      dt.textContent = pair[0];
      var dd = document.createElement("dd");
      dd.textContent = pair[1];
      metadataEl.appendChild(dt);
      metadataEl.appendChild(dd);
    });

    if (doc.headings.length === 0) {
      var noHeadings = document.createElement("li");
      noHeadings.className = "empty";
      noHeadings.textContent = "This artifact has no headings.";
      outlineEl.appendChild(noHeadings);
    } else {
      doc.headings.forEach(function (heading) {
        var li = document.createElement("li");
        var button = document.createElement("button");
        button.type = "button";
        button.className = "item outline-level-" + heading.level;
        button.textContent = heading.text;
        button.setAttribute("aria-label", heading.text + ", heading level " + heading.level);
        button.addEventListener("click", function () { revealHeading(heading); });
        li.appendChild(button);
        outlineEl.appendChild(li);
      });
    }

    // textContent keeps artifact source inert: no markup is ever parsed.
    sourceEl.textContent = doc.source;
  }

  function revealHeading(heading) {
    // The parser owns heading identification and reports the source line, so
    // the client never runs a second, fence-unaware counting pass. The target
    // is located by its rendered geometry rather than a line-index ratio, which
    // is wrong whenever line lengths are uneven.
    var src = state.document.source;
    var totalLines = src.split(/\r?\n/).length;
    if (typeof heading.line !== "number" || heading.line < 0 || heading.line >= totalLines) {
      setStatus("Heading not found in source: " + heading.text, "error");
      return;
    }

    // Scan for real line breaks so the offset stays exact for CRLF sources.
    var start = 0;
    for (var i = 0; i < heading.line; i++) {
      var nl = src.indexOf("\n", start);
      if (nl === -1) { start = -1; break; }
      start = nl + 1;
    }
    if (start === -1) {
      setStatus("Heading not found in source: " + heading.text, "error");
      return;
    }
    var lineEnd = src.indexOf("\n", start);
    var end = lineEnd === -1 ? src.length : lineEnd;
    if (end > start && src.charAt(end - 1) === "\r") end -= 1;

    var textNode = sourceEl.firstChild;
    var moved = false;
    if (textNode && textNode.nodeType === 3 && end <= textNode.length) {
      try {
        var range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        var rect = range.getBoundingClientRect();
        var box = sourceEl.getBoundingClientRect();
        sourceEl.scrollTop = Math.max(0, sourceEl.scrollTop + (rect.top - box.top));
        moved = true;
      } catch (err) {
        moved = false;
      }
    }
    if (!moved) {
      sourceEl.scrollTop = Math.floor(sourceEl.scrollHeight * (heading.line / Math.max(totalLines, 1)));
    }

    sourceEl.focus();
    setStatus("Moved to heading: " + heading.text, "info");
  }

  function select(artifactId) {
    setStatus("Loading artifact\u2026", "info");
    return request("/api/artifact?artifactId=" + encodeURIComponent(artifactId))
      .then(function (body) {
        state.selectedId = artifactId;
        state.document = body.artifact;
        renderList();
        renderDocument();
        setStatus("Loaded " + artifactId, "info");
      })
      .catch(function (err) {
        setStatus("Could not load artifact: " + err.message, "error");
      });
  }

  function applyList(body) {
    state.artifacts = body.artifacts;
    var nextId = state.selectedId;
    var targetChanged = Number.isInteger(body.targetRevision) && body.targetRevision > state.targetRevision;
    if (Number.isInteger(body.targetRevision)) state.targetRevision = body.targetRevision;
    if (
      targetChanged &&
      typeof body.selectedArtifactId === "string" &&
      state.artifacts.some(function (a) { return a.id === body.selectedArtifactId; })
    ) {
      nextId = body.selectedArtifactId;
      state.selectedId = nextId;
    }
    var stillPresent = state.artifacts.some(function (a) { return a.id === nextId; });
    if (nextId && !stillPresent) {
      nextId = null;
      state.selectedId = null;
      state.document = null;
      renderDocument();
    }
    renderList();
    setStatus(body.count === 1 ? "1 artifact available" : body.count + " artifacts available", "info");
    return nextId;
  }

  function load() {
    return request("/api/artifacts")
      .then(function (body) {
        var nextId = applyList(body);
        if (nextId) return select(nextId);
        return undefined;
      })
      .catch(function (err) {
        setStatus("Could not load artifacts: " + err.message, "error");
      });
  }

  function refresh() {
    setStatus("Refreshing from disk\u2026", "info");
    return request("/api/refresh", { method: "POST" })
      .then(function (body) {
        var nextId = applyList(body);
        if (nextId) return select(nextId);
        return undefined;
      })
      .catch(function (err) {
        setStatus("Could not refresh: " + err.message, "error");
      });
  }

  refreshBtn.addEventListener("click", refresh);

  if (typeof window.EventSource === "function") {
    try {
      var events = new EventSource(base + "/api/events");
      events.addEventListener("refresh", function () { refresh(); });
    } catch (err) {
      // Live refresh notification is optional; the button remains available.
    }
  }

  setStatus("Loading artifacts\u2026", "info");
  load();
})();
`;

/** Render the navigator document. Only escaped, provider-owned text is inlined. */
export function renderNavigatorHtml({ title } = {}) {
    const safeTitle = escapeHtml(title ?? "RPI Artifact Navigator");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>${safeTitle}</title>
<link rel="stylesheet" href="app.css" />
</head>
<body>
<a class="skip-link" href="#source">Skip to artifact source</a>
<div class="layout">
  <header class="toolbar">
    <h1>${safeTitle}</h1>
    <button id="refresh" type="button">Refresh from disk</button>
    <p id="status" class="status" role="status" aria-live="polite" data-tone="info">Loading artifacts&hellip;</p>
  </header>

  <section aria-labelledby="artifacts-heading">
    <h2 id="artifacts-heading">Artifacts</h2>
    <ul id="artifact-list" aria-labelledby="artifacts-heading"></ul>
  </section>

  <nav aria-labelledby="outline-heading">
    <section>
      <h2 id="outline-heading">Outline</h2>
      <ul id="outline-list" aria-labelledby="outline-heading"></ul>
    </section>
  </nav>

  <section aria-labelledby="document-title">
    <h2 id="document-title">No artifact selected</h2>
    <dl id="metadata" class="metadata"></dl>
    <pre id="source" class="source" tabindex="0" aria-label="Artifact source, read only"></pre>
  </section>
</div>
<script src="app.js" defer></script>
</body>
</html>`;
}
