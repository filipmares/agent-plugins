import { createHash } from "node:crypto";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { NotesError } from "./errors.mjs";
import { copilotHome } from "./platform.mjs";

export function shadowIndexDirectory(home = copilotHome()) {
    return join(home, "extensions", "notes", "index");
}

// v2 isolates generation-ordered workers from older writers that do not honor that protocol.
export function shadowIndexFile(root) {
    return `${createHash("sha256").update(root).digest("hex").slice(0, 32)}.v2.sqlite`;
}

// Only root invalidations cross the thread boundary, never full-library clones.
export class ShadowIndex {
    #directory;
    #log;
    #onFailure;
    #createWorker;
    #worker;
    #root;
    #busy = false;
    #pending = false;
    #disabled = false;
    #closing = false;
    #closed;
    #termination;
    #waiters = [];
    #action;
    #status = { state: "not_started", error: null, checked: null, details: null };

    constructor({ directory = shadowIndexDirectory(), log, onFailure,
        createWorker = options => new Worker(new URL("./index-worker.mjs", import.meta.url), options) } = {}) {
        this.#directory = directory;
        this.#log = log;
        this.#onFailure = onFailure;
        this.#createWorker = createWorker;
    }

    refresh(root) {
        if (this.#disabled || this.#closing) return;
        try {
            if (!this.#worker) {
                this.#root = root;
                const worker = this.#worker = this.#createWorker({ workerData: { root, directory: this.#directory } });
                worker.on("message", message => {
                    if (worker !== this.#worker || this.#disabled) return;
                    if (message.type === "failure") {
                        const error = Object.assign(new NotesError(message.code, "The background index failed."), { stack: message.stack });
                        this.#disable(error);
                    } else if (message.type === "done") {
                        this.#busy = false;
                        this.#status = { state: "idle", error: null,
                            checked: message.checked ? new Date().toISOString()
                                : message.details?.file === this.#status.details?.file ? this.#status.checked : null,
                            details: message.details ?? null };
                        if (this.#pending || this.#action) this.#send();
                        else {
                            worker.unref();
                            this.#settle();
                        }
                    }
                });
                worker.on("error", error => { if (worker === this.#worker) this.#disable(error); });
                worker.on("exit", () => {
                    if (worker !== this.#worker) return;
                    if ((!this.#closing || this.#busy) && !this.#disabled) this.#disable(new NotesError("index_unavailable", "The background index exited."));
                });
            }
            if (root !== this.#root) throw new NotesError("index_unavailable", "The index library changed.");
            this.#pending = true;
            if (!this.#busy) this.#send();
        } catch (error) { this.#disable(error); }
    }

    #send() {
        try {
            const type = this.#action ?? "refresh";
            this.#action = undefined;
            this.#pending = false;
            this.#busy = true;
            this.#status.state = type === "refresh" ? "syncing" : type === "check" ? "checking" : "rebuilding";
            this.#worker.ref();
            this.#worker.postMessage({ type });
        } catch (error) { this.#disable(error); }
    }

    status() {
        return structuredClone({ ...this.#status, managing: !!this.#action || ["checking", "rebuilding"].includes(this.#status.state) });
    }

    async manage(root, action) {
        if (!["check", "rebuild"].includes(action)) throw new NotesError("invalid_request", "Choose check or rebuild.");
        if (this.#closing) throw new NotesError("index_unavailable", "The index is closing.");
        if (this.#action || this.#busy) throw new NotesError("index_busy", "The index is already working. Wait and retry.");
        this.#action = action;
        if (this.#disabled) {
            await this.#termination;
            this.#worker = undefined;
            this.#disabled = false;
        }
        if (this.#closing) {
            this.#action = undefined;
            throw new NotesError("index_unavailable", "The index is closing.");
        }
        this.#status.error = null;
        this.refresh(root);
        return this.status();
    }

    // A barrier for tests and graceful shutdown, never awaited by a Notes request.
    flush() {
        if (this.#disabled || (!this.#busy && !this.#pending && !this.#action)) return Promise.resolve();
        return new Promise(resolve => this.#waiters.push(resolve));
    }

    #settle() {
        for (const resolve of this.#waiters.splice(0)) resolve();
    }

    close() {
        if (this.#closed) return this.#closed;
        this.#closing = true;
        this.#closed = this.#close();
        return this.#closed;
    }

    async #close() {
        const worker = this.#worker;
        if (!worker) return;
        // Allow large builds to drain, but do not keep the extension alive indefinitely.
        const timer = setTimeout(() => this.#disable(new NotesError("index_unavailable", "The background index exceeded its shutdown grace period.")), 30000);
        try {
            await this.flush();
            if (!this.#disabled) {
                worker.ref();
                await new Promise(resolve => {
                    worker.once("exit", resolve);
                    worker.postMessage({ type: "close" });
                });
            }
            await this.#termination;
        } catch (error) {
            this.#disable(error);
            await this.#termination;
        } finally { clearTimeout(timer); }
    }

    #disable(error) {
        if (this.#disabled) return;
        this.#disabled = true;
        this.#busy = false;
        this.#pending = false;
        this.#action = undefined;
        this.#status.state = "degraded";
        this.#status.error = error?.code ?? "index_unavailable";
        this.#termination = this.#worker?.terminate();
        this.#settle();
        report(() => this.#log?.(`The local shadow index is disabled (${error?.code ?? "index_unavailable"}). Retry or rebuild it in Notes settings. Notes continues to use its files.`, { level: "warning" }));
        report(() => this.#onFailure?.(error, error?.code ?? "index_unavailable"));
    }
}

// Reporting must never affect the Notes operation, whether it throws or rejects.
function report(callback) {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { /* ignored */ }
}
