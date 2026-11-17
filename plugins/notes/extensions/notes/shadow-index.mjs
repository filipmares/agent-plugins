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
                    if (message.type === "failure") {
                        const error = Object.assign(new NotesError(message.code, "The background index failed."), { stack: message.stack });
                        this.#disable(error);
                    } else if (message.type === "done") {
                        this.#busy = false;
                        if (this.#pending) this.#send();
                        else {
                            worker.unref();
                            this.#settle();
                        }
                    }
                });
                worker.on("error", error => this.#disable(error));
                worker.on("exit", () => {
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
            this.#pending = false;
            this.#busy = true;
            this.#worker.ref();
            this.#worker.postMessage({ type: "refresh" });
        } catch (error) { this.#disable(error); }
    }

    // A barrier for tests and graceful shutdown, never awaited by a Notes request.
    flush() {
        if (this.#disabled || (!this.#busy && !this.#pending)) return Promise.resolve();
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
        this.#termination = this.#worker?.terminate();
        this.#settle();
        report(() => this.#log?.(`The local shadow index is disabled until Notes restarts (${error?.code ?? "index_unavailable"}). Notes continues to use its files.`, { level: "warning" }));
        report(() => this.#onFailure?.(error, error?.code ?? "index_unavailable"));
    }
}

// Reporting must never affect the Notes operation, whether it throws or rejects.
function report(callback) {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { /* ignored */ }
}
