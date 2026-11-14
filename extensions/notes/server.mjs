// One loopback server per open Notes panel.
// Trust model: 127.0.0.1 only, a 256-bit capability path, exact Host checks,
// same-origin POSTs with JSON bodies, no CORS, and a strict CSP.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { NotesError } from "./errors.mjs";
import { PANEL_STARTUP_WATCHDOG_MS } from "./failure-journal.mjs";
import { openExternalLink } from "./platform.mjs";
import { loadUiState, popRecovery, pushRecovery, recoveryPath, saveUiState } from "./ui-state.mjs";

const [CLIENT_SCRIPT, EDITOR_SCRIPT, CLIENT_STYLES] = await Promise.all([
    readFile(new URL("./vendor/notes-client.js", import.meta.url), "utf8"),
    readFile(new URL("./vendor/notes-editor.js", import.meta.url), "utf8"),
    readFile(new URL("./vendor/notes-client.css", import.meta.url), "utf8"),
]);

// JSON escaping can roughly double an 8 MiB note.
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
].join("; ");

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes</title>
<link rel="stylesheet" href="app.css">
</head>
<body>
<div id="app" class="app"></div>
<script type="module" src="app.js"></script>
</body>
</html>
`;

const STATUS = {
    not_found: 404, conflict: 409, already_exists: 409, ambiguous_path: 409, trash_unavailable: 409,
    delete_cancelled: 409, note_too_large: 413, request_too_large: 413, unsafe_path: 403,
    library_busy: 503, server_closed: 503, unsupported_media_type: 415,
};

const ROUTES = {
    "/api/note/create": { body: "string", folder: "string", draft: "string?" },
    "/api/note/update": { id: "string", body: "string", expectedVersion: "string" },
    "/api/note/rescue": { id: "string?", draft: "string?", folder: "string", body: "string", expectedVersion: "string?", stash: "boolean?", key: "string?" },
    "/api/note/pin": { id: "string", pinned: "boolean", expectedVersion: "string" },
    "/api/note/move": { id: "string", folder: "string", expectedVersion: "string" },
    "/api/note/delete": { id: "string", expectedVersion: "string", permanent: "boolean?" },
    "/api/folder/create": { name: "string", parent: "string" },
    "/api/folder/rename": { folder: "string", name: "string", expectedVersion: "string" },
    "/api/folder/delete": { folder: "string", expectedVersion: "string", confirmed: "boolean", permanent: "boolean?" },
    "/api/ui": { state: "object" },
    "/api/open-link": { url: "string" },
    "/api/ask": { id: "string", expectedVersion: "string", prompt: "string" },
    "/api/startup": {},
};

function fields(body, spec) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new NotesError("invalid_request", "Send a JSON object.");
    for (const key of Object.keys(body)) {
        if (!(key in spec)) throw new NotesError("invalid_request", `Unsupported field: ${key}.`);
    }
    for (const [key, type] of Object.entries(spec)) {
        const optional = type.endsWith("?");
        if (body[key] === undefined && optional) continue;
        if (typeof body[key] !== type.replace("?", "") || body[key] === null) {
            throw new NotesError("invalid_request", `${key} must be a ${type.replace("?", "")}.`);
        }
    }
    return body;
}

function headers(res, type) {
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function send(res, status, type, body) {
    headers(res, type);
    res.statusCode = status;
    res.end(body);
}

const sendJson = (res, status, value) => send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

async function readJson(req, maxBytes = MAX_REQUEST_BYTES) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        throw new NotesError("unsupported_media_type", "Send application/json.");
    }
    if (Number(req.headers["content-length"] ?? 0) > maxBytes) {
        throw new NotesError("request_too_large", "The request is too large.");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw new NotesError("request_too_large", "The request is too large.");
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new NotesError("invalid_request", "The request body is not valid JSON.");
    }
}

function diagnosticFields(body) {
    const allowed = new Set(["eventName", "errorCode", "operationId", "route", "durationMs", "status", "stack", "recentOperations"]);
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => !allowed.has(key))
        || !["notes.browser.editor_failure", "notes.browser.request_failure", "notes.browser.startup_stalled", "notes.browser.unhandled_error", "notes.browser.unhandled_rejection"].includes(body.eventName)
        || typeof body.errorCode !== "string" || body.errorCode.length > 48
        || (body.operationId !== undefined && typeof body.operationId !== "string")
        || (body.route !== undefined && typeof body.route !== "string")
        || (body.durationMs !== undefined && !Number.isFinite(body.durationMs))
        || (body.status !== undefined && !Number.isSafeInteger(body.status))
        || (body.stack !== undefined && (!Array.isArray(body.stack) || body.stack.length > 10))
        || (body.recentOperations !== undefined && (!Array.isArray(body.recentOperations) || body.recentOperations.length > 20))) {
        throw new NotesError("invalid_request", "Diagnostic event does not match the expected shape.");
    }
    const frameKeys = new Set(["file", "function", "line", "column"]);
    if (body.stack?.some(frame => !frame || typeof frame !== "object" || Array.isArray(frame)
        || Object.keys(frame).some(key => !frameKeys.has(key)))) {
        throw new NotesError("invalid_request", "Diagnostic stack frame does not match the expected shape.");
    }
    const operationKeys = new Set(["operation", "route", "resultCode", "durationMs", "operationId", "status"]);
    if (body.recentOperations?.some(operation => !operation || typeof operation !== "object" || Array.isArray(operation)
        || Object.keys(operation).some(key => !operationKeys.has(key)))) {
        throw new NotesError("invalid_request", "Diagnostic operation does not match the expected shape.");
    }
    return body;
}

function findFolder(node, path) {
    if (node.path.toLowerCase() === path.toLowerCase()) return node;
    for (const child of node.children) {
        const found = findFolder(child, path);
        if (found) return found;
    }
    return undefined;
}

// How long a read waits for the library's first scan before answering library_busy. The scan keeps running.
export const LIBRARY_WAIT_MS = 15_000;

// A panel that has not claimed startup by then is journaled with the last stage it reached.
// Longer than LIBRARY_WAIT_MS, so a slow library first shows up as library_busy.
export const STARTUP_WATCHDOG_MS = PANEL_STARTUP_WATCHDOG_MS;
const STARTUP_STAGES = ["page_not_requested", "script_not_requested", "api_not_reached", "startup_incomplete"];

// Waits for the shared library without resetting or retrying its initialization.
export async function waitForLibrary(getLibrary, timeoutMs = LIBRARY_WAIT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new NotesError("library_busy", "Notes is still loading the library. Try again in a moment.")), timeoutMs);
        timer.unref?.();
    });
    try {
        return await Promise.race([getLibrary(), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

// Resolves a canvas target to canonical identifiers, failing for missing notes or folders.
// Only note and folder targets need the library, so empty and view targets never wait for it.
export async function resolveTarget(getLibrary, target = {}) {
    const resolved = {};
    if (target.view) resolved.view = target.view;
    if (target.folder === undefined && !target.noteId) return resolved;
    const library = await getLibrary();
    if (target.folder !== undefined) {
        const folder = findFolder((await library.folders()).folders, target.folder.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
        if (!folder) throw new NotesError("not_found", "The folder was not found.");
        resolved.folder = folder.path;
    }
    if (target.noteId) {
        const note = await library.read(target.noteId);
        resolved.noteId = note.id ?? note.path;
        if (resolved.folder === undefined && !resolved.view) resolved.folder = note.folder;
    }
    return resolved;
}

export async function createNotesServer({ getLibrary, getContext, sessionId, statePath, target, onChange, log, sendMessage, diagnostics, onStartup, onStartupStalled, onPanelClose, openLink = openExternalLink, libraryWaitMs = LIBRARY_WAIT_MS, startupWatchdogMs = STARTUP_WATCHDOG_MS }) {
    // Reads answer library_busy rather than hanging while the first scan runs; writes still queue for it.
    const readLibrary = () => waitForLibrary(getLibrary, libraryWaitMs);
    const token = randomBytes(32).toString("hex");
    const base = `/${token}`;
    const streams = new Set();
    // Versions this panel wrote, and drafts it created, so a closing panel's last save is not mistaken for a conflict.
    const written = new Map();
    const drafts = new Map();
    let writes = Promise.resolve();
    let pendingTarget = target && Object.keys(target).length ? target : null;
    let closed = false;
    let authority = "";
    let origin = "";
    let startupStage = 0;
    let startupWatchdog;
    const rejections = new Set();

    const userContext = async () => ({ ...await getContext(), actor: "user" });
    const reportProviderFailure = error => diagnostics?.recordFailure({
        eventName: "notes.provider.failure",
        errorCode: error?.code,
        attributes: { component: "provider" },
        stack: error?.stack,
    });
    // The session this panel's notes belong to: none when the app opened it without a session, which has no metadata to read.
    const panelContext = () => getContext().catch(() => ({ sessionId }));
    const changed = () => { try { onChange?.(); } catch { /* listeners must not fail the request */ } };

    function checkToken(pathname) {
        const segment = pathname.split("/")[1] ?? "";
        const expected = Buffer.from(token);
        const given = Buffer.from(segment);
        return given.length === expected.length && timingSafeEqual(given, expected);
    }

    // Journals each kind of trust-check rejection once per panel: the panel's own page cannot report it.
    async function rejectRequest(reason, route) {
        if (!rejections.has(reason)) {
            rejections.add(reason);
            await diagnostics?.recordFailure({
                eventName: "notes.request.rejected",
                errorCode: reason,
                severityText: "WARN",
                attributes: { component: "provider", route, status: 404 },
            });
        }
        throw new NotesError("not_found", "Not found.");
    }

    async function list(url) {
        const library = await readLibrary();
        const query = url.searchParams.get("query") ?? "";
        const view = url.searchParams.get("view");
        const folder = url.searchParams.get("folder");
        if (query.trim()) return library.list({ query });
        if (view === "all") return library.list();
        if (view === "session") {
            const { sessionId: owner } = await panelContext();
            return owner ? library.list({ session: owner }) : { notes: [], warnings: [] };
        }
        if (view === "project") {
            const { project } = await getContext().catch(() => ({}));
            return project ? library.list({ project }) : { notes: [], warnings: [] };
        }
        if (folder === null) throw new NotesError("invalid_request", "Choose a view or folder.");
        const result = await library.list({ folder });
        return { ...result, notes: result.notes.filter(note => note.folder.toLowerCase() === folder.toLowerCase()) };
    }

    // Saves text from a closing panel. Saves since its last-known version are only its own if this panel wrote them.
    // `stash` only keeps the text for the next load, for recovered text whose base version is unknown.
    async function rescue(library, { id, draft, folder, body, expectedVersion, stash, key: recoveryKey }) {
        if (stash) {
            await pushRecovery(recoveryPath(statePath), { noteId: id ?? null, folder, body, key: recoveryKey });
            return { recovered: true };
        }
        const noteId = id ?? (draft === undefined ? undefined : drafts.get(draft));
        const note = noteId === undefined ? null : await library.read(noteId).catch(error => {
            if (error?.code === "not_found") return null;
            throw error;
        });
        if (!note) {
            const created = await library.create({ body, folder }, await userContext());
            if (draft !== undefined) drafts.set(draft, created.id ?? created.path);
            return created;
        }
        if (note.body === body) return note;
        const key = note.id ?? note.path;
        if (note.version === expectedVersion || note.version === written.get(key)) {
            try {
                return await library.update(key, { body, expectedVersion: note.version }, await userContext());
            } catch (error) {
                if (error?.code !== "conflict") throw error;
            }
        }
        await pushRecovery(recoveryPath(statePath), { noteId: key, folder: note.folder, body });
        return { recovered: true };
    }

    async function post(route, body) {
        const library = await getLibrary();
        switch (route) {
            case "/api/note/create": {
                // Unload saves can arrive after the rescue that already created this draft; never create it twice.
                const existing = body.draft === undefined || !drafts.has(body.draft) ? null
                    : await library.read(drafts.get(body.draft)).catch(() => null);
                if (existing) return existing;
                const note = await library.create({ body: body.body, folder: body.folder }, await userContext());
                if (body.draft !== undefined) drafts.set(body.draft, note.id ?? note.path);
                return note;
            }
            case "/api/note/update": return library.update(body.id, { body: body.body, expectedVersion: body.expectedVersion }, await userContext());
            case "/api/note/rescue": return rescue(library, body);
            case "/api/note/pin": return library.pin(body.id, body.pinned, body.expectedVersion);
            case "/api/note/move": return library.move(body.id, { folder: body.folder, expectedVersion: body.expectedVersion });
            case "/api/note/delete":
                return library.delete(body.id, { expectedVersion: body.expectedVersion, confirmPermanent: async () => body.permanent === true });
            case "/api/folder/create": return library.createFolder(body.name, body.parent);
            case "/api/folder/rename": return library.renameFolder(body.folder, body.name, body.expectedVersion);
            case "/api/folder/delete":
                return library.deleteFolder(body.folder, {
                    expectedVersion: body.expectedVersion,
                    confirmDelete: async () => body.confirmed === true,
                    confirmPermanent: async () => body.permanent === true,
                });
        }
    }

    async function handle(req, res) {
        if (closed) throw new NotesError("server_closed", "This Notes panel is closed.");
        const url = new URL(req.url ?? "/", origin);
        // Checked first so only requests from this panel's page are journaled, not probes or favicon fetches.
        if (!checkToken(url.pathname)) throw new NotesError("not_found", "Not found.");
        const route = url.pathname.slice(base.length) || "/";
        if (req.headers.host !== authority) await rejectRequest("host_mismatch", route);
        const requestOrigin = req.headers.origin;
        if (requestOrigin !== undefined && requestOrigin !== origin) await rejectRequest(requestOrigin === "null" ? "origin_null" : "origin_mismatch", route);
        if (req.method === "POST" && requestOrigin !== origin && (ROUTES[route] || route === "/api/diagnostics")) await rejectRequest("origin_missing", route);
        startupStage = Math.max(startupStage, route === "/" ? 1 : route === "/app.js" ? 2 : route.startsWith("/api/") ? 3 : 0);

        if (req.method === "GET") {
            switch (route) {
                case "/": return send(res, 200, "text/html; charset=utf-8", HTML);
                case "/app.js": return send(res, 200, "text/javascript; charset=utf-8", CLIENT_SCRIPT);
                case "/editor.js": return send(res, 200, "text/javascript; charset=utf-8", EDITOR_SCRIPT);
                case "/app.css": return send(res, 200, "text/css; charset=utf-8", CLIENT_STYLES);
                case "/api/state": {
                    // Reading state has no side effects; the panel claims the open target and recovered text
                    // with /api/startup only once its lists have loaded, so a failed load loses neither.
                    const context = await panelContext();
                    return sendJson(res, 200, {
                        context: { sessionId: context.sessionId ?? null, project: context.project ?? null, sessionName: context.sessionName ?? null },
                        ui: await loadUiState(statePath, reportProviderFailure),
                    });
                }
                case "/api/folders": return sendJson(res, 200, await (await readLibrary()).folders());
                case "/api/notes": return sendJson(res, 200, await list(url));
                case "/api/note": {
                    const id = url.searchParams.get("id");
                    if (!id) throw new NotesError("invalid_request", "id is required.");
                    return sendJson(res, 200, await (await readLibrary()).read(id));
                }
                case "/api/image": {
                    const image = await (await readLibrary()).image(url.searchParams.get("noteId"), url.searchParams.get("src"));
                    headers(res, image.type);
                    if (image.type === "image/svg+xml") {
                        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
                    }
                    return res.end(image.bytes);
                }
                case "/api/events": {
                    headers(res, "text/event-stream; charset=utf-8");
                    res.statusCode = 200;
                    res.write(": connected\n\n");
                    streams.add(res);
                    res.on("close", () => streams.delete(res));
                    if (pendingTarget) {
                        res.write(`event: reveal\ndata: ${JSON.stringify(pendingTarget)}\n\n`);
                        pendingTarget = null;
                    }
                    return;
                }
            }
        }
        if (req.method === "POST" && (ROUTES[route] || route === "/api/diagnostics")) {
            const body = route === "/api/diagnostics"
                ? diagnosticFields(await readJson(req, 64 * 1024))
                : fields(await readJson(req), ROUTES[route]);
            if (route === "/api/diagnostics") {
                const recorded = await diagnostics?.recordFailure({
                    eventName: body.eventName,
                    errorCode: body.errorCode,
                    attributes: {
                        component: "browser",
                        route: body.route,
                        durationMs: body.durationMs,
                        status: body.status,
                        operationId: body.operationId,
                    },
                    stack: body.stack,
                    recentOperations: body.recentOperations,
                });
                return sendJson(res, 202, { recorded: recorded === true });
            }
            if (route === "/api/ui") return sendJson(res, 200, await saveUiState(statePath, body.state));
            if (route === "/api/startup") {
                const recovery = await popRecovery(recoveryPath(statePath), reportProviderFailure);
                const claimed = { target: pendingTarget, recovery };
                pendingTarget = null;
                clearTimeout(startupWatchdog);
                await onStartup?.();
                return sendJson(res, 200, claimed);
            }
            if (route === "/api/open-link") {
                await openLink(body.url);
                return sendJson(res, 200, { opened: true });
            }
            if (route === "/api/ask") {
                if (!body.prompt.trim() || body.prompt.length > 16000) throw new NotesError("invalid_request", "Enter a prompt of up to 16000 characters.");
                const { sessionId: owner } = await panelContext();
                if (!sendMessage || !owner) throw new NotesError("chat_unavailable", "Ask Copilot needs a Copilot session, and this panel was opened without one.");
                await writes;
                const attachment = await (await getLibrary()).attachment(body.id, body.expectedVersion);
                // SDK MessageOptions: enqueue is the documented busy-session delivery mode; never drop the file on failure.
                const messageId = await sendMessage({ prompt: body.prompt, attachments: [attachment], mode: "enqueue" }, owner);
                if (typeof messageId !== "string" || !messageId) throw new NotesError("chat_unavailable", "Copilot did not acknowledge the message.");
                return sendJson(res, 200, { messageId });
            }
            // Stashing only keeps text for the next load, so it must not wait for a library that may still be loading.
            if (route === "/api/note/rescue" && body.stash) return sendJson(res, 200, await rescue(null, body));
            const run = writes.then(() => post(route, body));
            writes = run.catch(() => {});
            const result = await run;
            if (typeof result?.version === "string") written.set(result.id ?? result.path, result.version);
            changed();
            return sendJson(res, 200, result);
        }
        throw new NotesError("not_found", "Not found.");
    }

    const server = createServer((req, res) => {
        const started = Date.now();
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const route = url.pathname.slice(base.length) || "/";
        const track = route !== "/api/diagnostics" && route !== "/api/events" && route.startsWith("/api/");
        const operationId = typeof req.headers["x-notes-operation-id"] === "string"
            && /^[\da-f-]{36}$/i.test(req.headers["x-notes-operation-id"])
            ? req.headers["x-notes-operation-id"] : randomUUID();
        handle(req, res).then(() => {
            if (track) diagnostics?.recordOperation({
                component: "provider", route, status: res.statusCode,
                durationMs: Date.now() - started, operationId, resultCode: "ok",
            });
        }).catch(async error => {
            const known = error instanceof NotesError;
            const status = known ? STATUS[error.code] ?? 400 : 500;
            const code = known ? error.code : error?.code ?? "unexpected_error";
            if (track) {
                diagnostics?.recordOperation({
                    component: "provider", route, status,
                    durationMs: Date.now() - started, operationId, resultCode: code,
                });
                await diagnostics?.recordFailure({
                    eventName: "notes.request.failure",
                    errorCode: code,
                    attributes: { component: "provider", route, status, durationMs: Date.now() - started, operationId },
                    stack: error?.stack,
                });
            }
            if (!known) log?.(`Notes request failed: ${error.code ?? error.message}`, { level: "error" });
            if (res.headersSent) return res.destroy();
            if (error.code === "request_too_large") res.setHeader("Connection", "close");
            sendJson(res, status, {
                error: known
                    ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
                    : { code: "io_error", message: `Notes could not complete the request (${error.code ?? "unexpected error"}).` },
            });
        }).catch(() => {
            if (!res.headersSent) sendJson(res, 500, { error: { code: "io_error", message: "Notes could not complete the request." } });
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    authority = `127.0.0.1:${server.address().port}`;
    origin = `http://${authority}`;
    if (diagnostics) {
        startupWatchdog = setTimeout(() => void diagnostics.recordFailure({
            eventName: "notes.panel.startup_stalled",
            errorCode: STARTUP_STAGES[startupStage],
            severityText: "WARN",
            attributes: { component: "provider", durationMs: startupWatchdogMs },
        }).then(recorded => recorded && onStartupStalled?.()), startupWatchdogMs);
        startupWatchdog.unref?.();
    }

    function emit(event, data) {
        for (const stream of streams) {
            try { stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { streams.delete(stream); }
        }
    }

    return {
        url: `${origin}${base}/`,
        get closed() { return closed; },
        reveal(next) {
            if (closed) return;
            if (streams.size) emit("reveal", next);
            else pendingTarget = next;
        },
        notifyChange() { if (!closed) emit("changed", {}); },
        async close() {
            if (closed) return;
            closed = true;
            clearTimeout(startupWatchdog);
            await onPanelClose?.();
            for (const stream of streams) stream.end();
            streams.clear();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
