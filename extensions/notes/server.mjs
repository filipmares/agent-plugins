// One loopback server per open Notes panel.
// Trust model: 127.0.0.1 only, a 256-bit capability path, exact Host checks,
// same-origin POSTs with JSON bodies, no CORS, and a strict CSP.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { NotesError } from "./errors.mjs";
import { openExternalLink } from "./platform.mjs";
import { loadUiState, popRecovery, pushRecovery, recoveryPath, saveUiState } from "./ui-state.mjs";

const [CLIENT_SCRIPT, CLIENT_STYLES] = await Promise.all([
    readFile(new URL("./vendor/notes-client.js", import.meta.url), "utf8"),
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
<script src="app.js" defer></script>
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
    "/api/note/rescue": { id: "string?", draft: "string?", folder: "string", body: "string", expectedVersion: "string?", stash: "boolean?" },
    "/api/note/pin": { id: "string", pinned: "boolean", expectedVersion: "string" },
    "/api/note/move": { id: "string", folder: "string", expectedVersion: "string" },
    "/api/note/delete": { id: "string", expectedVersion: "string", permanent: "boolean?" },
    "/api/folder/create": { name: "string", parent: "string" },
    "/api/folder/rename": { folder: "string", name: "string", expectedVersion: "string" },
    "/api/folder/delete": { folder: "string", expectedVersion: "string", confirmed: "boolean", permanent: "boolean?" },
    "/api/ui": { state: "object" },
    "/api/open-link": { url: "string" },
    "/api/ask": { id: "string", expectedVersion: "string", prompt: "string" },
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

async function readJson(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        throw new NotesError("unsupported_media_type", "Send application/json.");
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) {
        throw new NotesError("request_too_large", "The request is too large.");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new NotesError("request_too_large", "The request is too large.");
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new NotesError("invalid_request", "The request body is not valid JSON.");
    }
}

function findFolder(node, path) {
    if (node.path.toLowerCase() === path.toLowerCase()) return node;
    for (const child of node.children) {
        const found = findFolder(child, path);
        if (found) return found;
    }
    return undefined;
}

// Resolves a canvas target to canonical identifiers, failing for missing notes or folders.
export async function resolveTarget(library, target = {}) {
    const resolved = {};
    if (target.view) resolved.view = target.view;
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

export async function createNotesServer({ getLibrary, getContext, sessionId, statePath, target, onChange, log, sendMessage, openLink = openExternalLink }) {
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

    const userContext = async () => ({ ...await getContext(), actor: "user" });
    const changed = () => { try { onChange?.(); } catch { /* listeners must not fail the request */ } };

    function checkToken(pathname) {
        const segment = pathname.split("/")[1] ?? "";
        const expected = Buffer.from(token);
        const given = Buffer.from(segment);
        return given.length === expected.length && timingSafeEqual(given, expected);
    }

    async function list(url) {
        const library = await getLibrary();
        const query = url.searchParams.get("query") ?? "";
        const view = url.searchParams.get("view");
        const folder = url.searchParams.get("folder");
        if (query.trim()) return library.list({ query });
        if (view === "all") return library.list();
        if (view === "session") return library.list({ session: sessionId });
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
    async function rescue(library, { id, draft, folder, body, expectedVersion, stash }) {
        if (stash) {
            await pushRecovery(recoveryPath(statePath), { noteId: id ?? null, folder, body });
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
        if (req.headers.host !== authority) throw new NotesError("not_found", "Not found.");
        const requestOrigin = req.headers.origin;
        if (requestOrigin !== undefined && requestOrigin !== origin) throw new NotesError("not_found", "Not found.");
        const url = new URL(req.url ?? "/", origin);
        if (!checkToken(url.pathname)) throw new NotesError("not_found", "Not found.");
        const route = url.pathname.slice(base.length) || "/";

        if (req.method === "GET") {
            switch (route) {
                case "/": return send(res, 200, "text/html; charset=utf-8", HTML);
                case "/app.js": return send(res, 200, "text/javascript; charset=utf-8", CLIENT_SCRIPT);
                case "/app.css": return send(res, 200, "text/css; charset=utf-8", CLIENT_STYLES);
                case "/api/state": {
                    const context = await getContext().catch(() => ({ sessionId }));
                    const state = {
                        context: { sessionId, project: context.project ?? null, sessionName: context.sessionName ?? null },
                        ui: await loadUiState(statePath),
                        target: pendingTarget,
                        recovery: await popRecovery(recoveryPath(statePath)),
                    };
                    pendingTarget = null;
                    return sendJson(res, 200, state);
                }
                case "/api/folders": return sendJson(res, 200, await (await getLibrary()).folders());
                case "/api/notes": return sendJson(res, 200, await list(url));
                case "/api/note": {
                    const id = url.searchParams.get("id");
                    if (!id) throw new NotesError("invalid_request", "id is required.");
                    return sendJson(res, 200, await (await getLibrary()).read(id));
                }
                case "/api/image": {
                    const image = await (await getLibrary()).image(url.searchParams.get("noteId"), url.searchParams.get("src"));
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
        if (req.method === "POST" && ROUTES[route]) {
            if (requestOrigin !== origin) throw new NotesError("not_found", "Not found.");
            const body = fields(await readJson(req), ROUTES[route]);
            if (route === "/api/ui") return sendJson(res, 200, await saveUiState(statePath, body.state));
            if (route === "/api/open-link") {
                await openLink(body.url);
                return sendJson(res, 200, { opened: true });
            }
            if (route === "/api/ask") {
                if (!body.prompt.trim() || body.prompt.length > 16000) throw new NotesError("invalid_request", "Enter a prompt of up to 16000 characters.");
                if (!sendMessage) throw new NotesError("chat_unavailable", "This panel is not connected to its Copilot session.");
                await writes;
                const attachment = await (await getLibrary()).attachment(body.id, body.expectedVersion);
                // SDK MessageOptions: enqueue is the documented busy-session delivery mode; never drop the file on failure.
                const messageId = await sendMessage({ prompt: body.prompt, attachments: [attachment], mode: "enqueue" }, sessionId);
                if (typeof messageId !== "string" || !messageId) throw new NotesError("chat_unavailable", "Copilot did not acknowledge the message.");
                return sendJson(res, 200, { messageId });
            }
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
        handle(req, res).catch(error => {
            const known = error instanceof NotesError;
            if (!known) log?.(`Notes request failed: ${error.code ?? error.message}`, { level: "error" });
            if (res.headersSent) return res.destroy();
            if (error.code === "request_too_large") res.setHeader("Connection", "close");
            sendJson(res, known ? STATUS[error.code] ?? 400 : 500, {
                error: known
                    ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
                    : { code: "io_error", message: `Notes could not complete the request (${error.code ?? "unexpected error"}).` },
            });
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    authority = `127.0.0.1:${server.address().port}`;
    origin = `http://${authority}`;

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
            for (const stream of streams) stream.end();
            streams.clear();
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
