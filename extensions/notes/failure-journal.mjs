import { createHash, randomBytes } from "node:crypto";
import { arch, hostname, release } from "node:os";
import { dirname, join } from "node:path";
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isTransientFsError, retryTransient } from "./filesystem.mjs";
import { copilotHome } from "./platform.mjs";

export const MAX_JOURNAL_BYTES = 1024 * 1024;
export const MAX_BUNDLE_BYTES = 20 * 1024;
export const FAILURE_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PANEL_STARTUP_WATCHDOG_MS = 30_000;
const MAX_RECENT_OPERATIONS = 20;
const MAX_STACK_FRAMES = 10;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 60_000;
const EXPECTED_CODES = new Set([
    "already_exists", "ambiguous_match", "ambiguous_path", "chat_unavailable", "conflict",
    "delete_cancelled", "invalid_encoding", "invalid_frontmatter", "invalid_name", "invalid_path",
    "invalid_request", "invalid_session", "match_not_found", "not_found", "note_too_large",
    "request_too_large", "server_closed", "unsafe_path", "unsafe_url", "unsupported_media_type",
]);
const NOTES_CODES = new Set([
    ...EXPECTED_CODES, "asset_link_unsupported", "delete_incomplete", "documents_unavailable",
    "io_error", "library_busy", "lock_changed", "move_incomplete", "offline", "open_failed",
    "platform_unsupported", "session_metadata_unavailable", "server_closed", "startup_abandoned", "trash_unavailable",
    // Trust-check rejections of requests that carried the panel's capability token.
    "host_mismatch", "origin_missing", "origin_mismatch", "origin_null",
    // The last startup stage a stalled panel reached, from the provider's and the browser's side.
    "page_not_requested", "script_not_requested", "api_not_reached", "startup_incomplete",
    "state_pending", "lists_pending", "startup_claim_pending",
]);
const SYSTEM_CODES = new Set([
    "EACCES", "EBUSY", "ECONNREFUSED", "ECONNRESET", "EEXIST", "EIO", "EISDIR", "EMFILE",
    "ENFILE", "ENOENT", "ENOMEM", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EPIPE",
    "ETIMEDOUT", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_STATE", "ERR_MODULE_NOT_FOUND",
]);
const COMPONENTS = new Set(["browser", "canvas", "provider", "tool", "watcher"]);
const TOOL_OPERATIONS = new Set(["append", "create", "delete", "folders", "move", "read", "search", "update"]);
const ROUTES = new Set([
    "/", "/app.css", "/app.js", "/editor.js",
    "/api/ask", "/api/diagnostics", "/api/events", "/api/folder/create", "/api/folder/delete",
    "/api/folder/rename", "/api/folders", "/api/image", "/api/note", "/api/note/create",
    "/api/note/delete", "/api/note/move", "/api/note/pin", "/api/note/rescue", "/api/note/update",
    "/api/notes", "/api/open-link", "/api/startup", "/api/state", "/api/ui",
]);
const EVENTS = new Set([
    "notes.browser.editor_failure", "notes.browser.request_failure", "notes.browser.startup_stalled",
    "notes.browser.unhandled_error", "notes.browser.unhandled_rejection", "notes.canvas.open_failure",
    "notes.panel.startup_abandoned", "notes.panel.startup_stalled", "notes.provider.failure",
    "notes.request.failure", "notes.request.rejected",
    "notes.session.shutdown_failure", "notes.tool.failure", "notes.watcher.degraded",
]);
const BROWSER_FILES = new Set(["app.js", "editor.js"]);
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const VERSION = /^\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/;
const CODE = /^[A-Z][A-Z0-9_]{0,47}$|^[a-z][a-z0-9_]{0,47}$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;

export function failureJournalPath(home = copilotHome()) {
    return join(home, "extensions", "notes", "artifacts", "failure-journal.jsonl");
}

function safeCode(value) {
    if (typeof value !== "string" || !CODE.test(value)) return "unexpected_error";
    if (NOTES_CODES.has(value) || SYSTEM_CODES.has(value)) return value;
    return "unexpected_error";
}

export function isExpectedFailureCode(value) {
    return EXPECTED_CODES.has(value);
}

function safeRoute(value) {
    return typeof value === "string" && ROUTES.has(value) ? value : undefined;
}

function safeOperation(value) {
    return typeof value === "string" && TOOL_OPERATIONS.has(value) ? value : undefined;
}

function safeOperationId(value) {
    return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

function stackFrames(stack) {
    if (typeof stack !== "string") return [];
    const frames = [];
    for (const line of stack.split("\n")) {
        if (!/^\s*at\s/.test(line)) continue;
        const match = /(?:^|[\\/])extensions[\\/]notes[\\/]([^:\r\n]+):(\d+):(\d+)\)?\s*$/.exec(line);
        if (!match) continue;
        const parts = match[1].replaceAll("\\", "/").split("/");
        if (parts.some(part => !part || part === "." || part === "..")) continue;
        frames.push({ file: `extensions/notes/${parts.join("/")}`, line: Number(match[2]), column: Number(match[3]) });
        if (frames.length === MAX_STACK_FRAMES) break;
    }
    return frames;
}

function browserFrames(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_STACK_FRAMES).flatMap(frame => {
        if (!frame || typeof frame !== "object" || !BROWSER_FILES.has(frame.file)
            || !Number.isSafeInteger(frame.line) || frame.line < 1
            || !Number.isSafeInteger(frame.column) || frame.column < 1) return [];
        return [{
            file: frame.file,
            ...(typeof frame.function === "string" && IDENTIFIER.test(frame.function) ? { function: frame.function } : {}),
            line: frame.line,
            column: frame.column,
        }];
    });
}

function safeAttributes({ component, route, operation, status, durationMs, operationId, resultCode, errorCode } = {}) {
    const attributes = {};
    if (COMPONENTS.has(component)) attributes.component = component;
    if (safeRoute(route)) attributes.route = route;
    if (safeOperation(operation)) attributes.operation = operation;
    if (errorCode !== undefined) attributes.errorCode = safeCode(errorCode);
    if (Number.isSafeInteger(status) && status >= 100 && status <= 599) attributes.status = status;
    if (Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 600_000) {
        attributes.durationMs = Math.round(durationMs);
    }
    if (safeOperationId(operationId)) attributes.operationId = safeOperationId(operationId);
    if (resultCode === "ok") attributes.resultCode = "ok";
    else if (typeof resultCode === "string" && safeCode(resultCode) !== "unexpected_error") {
        attributes.resultCode = safeCode(resultCode);
    }
    return attributes;
}

function safeRecentOperations(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_RECENT_OPERATIONS).flatMap(operation => {
        if (!operation || typeof operation !== "object") return [];
        const attributes = safeAttributes(operation);
        if (!attributes.operation && !attributes.route) return [];
        return [{
            ...attributes,
            ...(safeOperationId(operation.operationId) ? { operationId: safeOperationId(operation.operationId) } : {}),
        }];
    });
}

function safeFrameList(frames, component) {
    if (component === "browser") return browserFrames(frames);
    return Array.isArray(frames) ? frames.slice(0, MAX_STACK_FRAMES).flatMap(frame => {
        if (!frame || typeof frame !== "object" || typeof frame.file !== "string"
            || !/^extensions\/notes\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(frame.file)
            || !Number.isSafeInteger(frame.line) || frame.line < 1
            || !Number.isSafeInteger(frame.column) || frame.column < 1) return [];
        return [{ file: frame.file, line: frame.line, column: frame.column }];
    }) : [];
}

function safeIncident(value) {
    if (!value || typeof value !== "object" || !EVENTS.has(value.eventName)) return null;
    const errorCode = safeCode(value.errorCode ?? value.attributes?.errorCode);
    const attributes = safeAttributes({ ...value.attributes, errorCode });
    const component = attributes.component;
    if (!component) return null;
    const frames = safeFrameList(value.stack, component);
    const fingerprint = createHash("sha256").update(JSON.stringify([
        value.eventName, attributes.errorCode, attributes.component, attributes.route, attributes.operation, frames.slice(0, 3),
    ])).digest("hex").slice(0, 24);
    const timestamp = typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))
        ? new Date(value.timestamp).toISOString() : new Date().toISOString();
    return {
        timestamp,
        severityText: value.severityText === "WARN" ? "WARN" : "ERROR",
        eventName: value.eventName,
        attributes,
        ...(frames.length ? { stack: frames } : {}),
        ...(Array.isArray(value.recentOperations) ? { recentOperations: safeRecentOperations(value.recentOperations) } : {}),
        fingerprint,
        firstSeen: typeof value.firstSeen === "string" && Number.isFinite(Date.parse(value.firstSeen))
            ? new Date(value.firstSeen).toISOString() : timestamp,
        lastSeen: typeof value.lastSeen === "string" && Number.isFinite(Date.parse(value.lastSeen))
            ? new Date(value.lastSeen).toISOString() : timestamp,
        occurrences: Number.isSafeInteger(value.occurrences) && value.occurrences > 0
            ? Math.min(value.occurrences, 1_000_000) : 1,
    };
}

async function readRecords(path) {
    let handle;
    try {
        handle = await open(path, "r");
        const size = (await handle.stat()).size;
        const length = Math.min(size, MAX_JOURNAL_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, size - length));
        let text = buffer.subarray(0, bytesRead).toString("utf8");
        if (size > length) text = text.slice(text.indexOf("\n") + 1);
        return text.split("\n").filter(Boolean).flatMap(line => {
            try {
                const record = safeIncident(JSON.parse(line));
                return record ? [record] : [];
            } catch {
                return [];
            }
        });
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
    } finally {
        await handle?.close();
    }
}

function trimRecords(records, now) {
    return records.filter(record => now - Date.parse(record.lastSeen) <= FAILURE_JOURNAL_RETENTION_MS)
        .sort((a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen));
}

function serializeRecords(records) {
    while (records.length && Buffer.byteLength(records.map(record => JSON.stringify(record)).join("\n") + "\n") > MAX_JOURNAL_BYTES) {
        records.shift();
    }
    return records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

async function acquireLock(path) {
    const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomBytes(12).toString("hex") });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
        try {
            const handle = await open(path, "wx", 0o600);
            let written = false;
            try {
                await handle.writeFile(owner);
                written = true;
            } finally {
                await handle.close();
                if (!written && await readFile(path, "utf8").catch(() => null) === owner) await unlink(path);
            }
            return async () => {
                if (await retryTransient(() => readFile(path, "utf8")) === owner) await retryTransient(() => unlink(path));
            };
        } catch (error) {
            // A lock another writer is still deleting reports EPERM on Windows until its handles close.
            if (error?.code !== "EEXIST" && !isTransientFsError(error)) throw error;
            try {
                const details = await lstat(path);
                if (!details.isFile() || details.isSymbolicLink()) throw new Error("diagnostic journal lock is not a regular file");
                const contents = await readFile(path, "utf8");
                let stale = Date.now() - details.mtimeMs > STALE_LOCK_MS;
                try {
                    const lock = JSON.parse(contents);
                    if (lock.host === hostname() && Number.isSafeInteger(lock.pid)) {
                        try { process.kill(lock.pid, 0); stale = false; }
                        catch (failure) { stale = failure?.code === "ESRCH"; }
                    }
                } catch { /* a partial lock is stale only after the age threshold */ }
                if (stale && await readFile(path, "utf8") === contents) await unlink(path);
            } catch (failure) {
                if (failure?.code !== "ENOENT" && !isTransientFsError(failure)) throw failure;
            }
            if (Date.now() >= deadline) throw new Error("diagnostic journal lock timed out");
            await delay(10);
        }
    }
}

async function writeJournal(path, records) {
    const content = serializeRecords(records);
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
        await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        await retryTransient(() => rename(temporary, path));
    } finally {
        await retryTransient(() => rm(temporary, { force: true }));
    }
}

function safeVersion(value) {
    return typeof value === "string" && value.length <= 64 && VERSION.test(value) ? value : undefined;
}

function safeEnvironment(value = {}) {
    const environment = {};
    for (const [key, name] of [
        ["notesVersion", "notesVersion"], ["copilotAppVersion", "copilotAppVersion"],
        ["copilotSdkVersion", "copilotSdkVersion"], ["nodeVersion", "nodeVersion"],
        ["platform", "platform"], ["osVersion", "osVersion"], ["architecture", "architecture"],
    ]) {
        const version = ["notesVersion", "copilotAppVersion", "copilotSdkVersion", "nodeVersion"].includes(key);
        const item = version ? safeVersion(value[name]) : value[name];
        if (typeof item === "string" && item.length <= 128 && /^[A-Za-z0-9._+-]+$/.test(item)) environment[key] = item;
    }
    return environment;
}

function processExists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code !== "ESRCH"; }
}

export function defaultEnvironment() {
    return safeEnvironment({
        notesVersion: process.env.COPILOT_PLUGIN_VERSION,
        copilotAppVersion: process.env.COPILOT_APP_VERSION,
        copilotSdkVersion: process.env.COPILOT_SDK_VERSION,
        nodeVersion: process.versions.node,
        platform: process.platform,
        osVersion: release(),
        architecture: arch(),
    });
}

export class FailureJournal {
    #operations = [];
    #queue = Promise.resolve();
    #warned = false;

    constructor({ path = failureJournalPath(), log, environment = defaultEnvironment(), now = () => new Date() } = {}) {
        this.path = path;
        this.log = log;
        this.environment = safeEnvironment(environment);
        this.now = now;
    }

    #warnStorageFailure() {
        if (this.#warned) return;
        this.#warned = true;
        try { this.log?.("Notes diagnostic journal could not save a failure.", { level: "warning" }); }
        catch { /* logging must not affect the Notes operation */ }
    }

    async beginPanelStartup() {
        const directory = `${this.path}.pending`;
        const markerPath = join(directory, `${randomBytes(16).toString("hex")}.json`);
        try {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFile(markerPath, JSON.stringify({
                pid: process.pid,
                startedAt: this.now().toISOString(),
            }), { flag: "wx", mode: 0o600 });
        } catch {
            this.#warnStorageFailure();
            return undefined;
        }

        let completed = false;
        return async () => {
            if (completed) return;
            try {
                await retryTransient(() => unlink(markerPath));
                completed = true;
            } catch (error) {
                if (error?.code === "ENOENT") completed = true;
                else this.#warnStorageFailure();
            }
        };
    }

    async recoverAbandonedPanelStarts() {
        const directory = `${this.path}.pending`;
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (error?.code !== "ENOENT") this.#warnStorageFailure();
            return 0;
        }

        let recovered = 0;
        for (const entry of entries) {
            const name = entry.name;
            const match = /^([a-f\d]{32}\.json)(?:\.claim\.(\d+)\.[a-f\d]{8})?$/i.exec(name);
            if (!entry.isFile() || !match) continue;
            const markerPath = join(directory, name);

            let marker;
            try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
            catch (error) {
                if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) this.#warnStorageFailure();
                continue;
            }
            const startedAt = Date.parse(marker.startedAt);
            if (!Number.isSafeInteger(marker.pid) || marker.pid < 1 || !Number.isFinite(startedAt)) continue;
            const ageMs = Math.max(0, Date.parse(this.now().toISOString()) - startedAt);
            if (ageMs < PANEL_STARTUP_WATCHDOG_MS
                && (processExists(marker.pid) || (match[2] && processExists(Number(match[2]))))) continue;

            const claimPath = `${markerPath}.claim.${process.pid}.${randomBytes(4).toString("hex")}`;
            try { await retryTransient(() => rename(markerPath, claimPath)); }
            catch (error) {
                if (error?.code !== "ENOENT") this.#warnStorageFailure();
                continue;
            }

            const recorded = await this.recordFailure({
                eventName: "notes.panel.startup_abandoned",
                errorCode: "startup_abandoned",
                severityText: "WARN",
                attributes: { component: "provider", durationMs: Math.min(600_000, ageMs) },
            });
            if (!recorded) continue;
            try {
                await retryTransient(() => unlink(claimPath));
                recovered++;
            } catch (error) {
                if (error?.code !== "ENOENT") this.#warnStorageFailure();
            }
        }
        return recovered;
    }

    recordOperation(operation) {
        const attributes = safeAttributes(operation);
        if (!attributes.operation && !attributes.route) return;
        this.#operations.push(attributes);
        if (this.#operations.length > MAX_RECENT_OPERATIONS) this.#operations.shift();
    }

    async recordFailure(event) {
        const now = this.now().toISOString();
        const component = event?.attributes?.component;
        const incident = safeIncident({
            ...event,
            errorCode: safeCode(event?.errorCode),
            timestamp: now,
            firstSeen: now,
            lastSeen: now,
            occurrences: 1,
            stack: typeof event?.stack === "string" ? stackFrames(event.stack)
                : safeFrameList(event?.stack, component),
            recentOperations: event?.recentOperations ?? this.#operations,
        });
        if (!incident || isExpectedFailureCode(event?.errorCode)) return false;

        const run = this.#queue.then(async () => {
            await mkdir(dirname(this.path), { recursive: true });
            const release = await acquireLock(`${this.path}.lock`);
            try {
                const records = trimRecords(await readRecords(this.path), Date.parse(now));
                const existing = records.find(record => record.fingerprint === incident.fingerprint);
                if (existing) {
                    existing.timestamp = now;
                    existing.lastSeen = now;
                    existing.occurrences = Math.min(existing.occurrences + 1, 1_000_000);
                    existing.recentOperations = incident.recentOperations;
                    if (incident.stack?.length) existing.stack = incident.stack;
                    records.splice(records.indexOf(existing), 1);
                    records.push(existing);
                } else records.push(incident);
                await writeJournal(this.path, records);
            } finally {
                await release();
            }
            return true;
        });
        this.#queue = run.catch(() => {});
        try {
            return await run;
        } catch {
            this.#warnStorageFailure();
            return false;
        }
    }

    async renderIssueBundle() {
        await this.#queue;
        const now = Date.parse(this.now().toISOString());
        const records = trimRecords(await readRecords(this.path), now).reverse();
        let notesVersion = this.environment.notesVersion;
        if (!notesVersion) {
            try {
                const manifest = JSON.parse(await readFile(new URL("../../.github/plugin/plugin.json", import.meta.url), "utf8"));
                notesVersion = safeVersion(manifest.version);
            } catch { /* standalone extension imports may not include the repository manifest */ }
        }
        const lines = [JSON.stringify({ schemaVersion: 1, environment: safeEnvironment({ ...this.environment, notesVersion }) })];
        for (const record of records) {
            const candidate = [...lines, JSON.stringify(record)].join("\n");
            const bundle = `\`\`\`json\n${candidate}\n\`\`\``;
            if (Buffer.byteLength(bundle) > MAX_BUNDLE_BYTES) break;
            lines.push(JSON.stringify(record));
        }
        return `\`\`\`json\n${lines.join("\n")}\n\`\`\``;
    }
}

