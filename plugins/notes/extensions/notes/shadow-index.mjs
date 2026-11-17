import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { NotesError } from "./errors.mjs";
import { copilotHome } from "./platform.mjs";

// The version is part of the file name, so different schemas never share a database.
const SCHEMA_VERSION = 1;
// Writers already hold the library lock; this only waits out other readers of the file.
const BUSY_TIMEOUT_MS = 1000;
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY, version TEXT NOT NULL, mtime_ms REAL NOT NULL,
        frontmatter TEXT NOT NULL, body TEXT NOT NULL, warning TEXT);
    CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS warnings (position INTEGER PRIMARY KEY, path TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL);`;

export function shadowIndexDirectory(home = copilotHome()) {
    return join(home, "extensions", "notes", "index");
}

export function shadowIndexFile(root) {
    return `${createHash("sha256").update(root).digest("hex").slice(0, 32)}.v${SCHEMA_VERSION}.sqlite`;
}

function failureCode(error) {
    switch (error?.errcode & 0xff) {
        case 5: case 6: return "index_busy";
        case 11: case 26: return "index_corrupt";
    }
    return error?.code;
}

// A local, disposable SQLite copy of the latest completed scan. Nothing reads it yet;
// any failure disables it for this process and Notes keeps using its files.
export class ShadowIndex {
    #directory;
    #log;
    #onFailure;
    #loadSqlite;
    #db;
    #statements;
    #disabled = false;

    constructor({ directory = shadowIndexDirectory(), log, onFailure, loadSqlite = () => import("node:sqlite") } = {}) {
        this.#directory = directory;
        this.#log = log;
        this.#onFailure = onFailure;
        this.#loadSqlite = loadSqlite;
    }

    // Called under the library lock, so writers from every process are serialized and ordered.
    async update(root, snapshot, signature) {
        if (this.#disabled) return;
        try {
            if (!this.#db) {
                await this.#open(root);
                // close() may have run while the database was opening.
                if (this.#disabled) return this.close();
            }
            this.#write(snapshot, signature);
        } catch (error) {
            this.#disable(error);
        }
    }

    // Final: a closed index is never reopened.
    close() {
        this.#disabled = true;
        const db = this.#db;
        this.#db = this.#statements = undefined;
        try { db?.close(); } catch { /* already closed */ }
    }

    async #open(root) {
        const location = relative(root, this.#directory);
        if (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`)) {
            throw new NotesError("index_unavailable", "The index directory is inside the Notes library.");
        }
        let sqlite;
        try { sqlite = await this.#loadSqlite(); } catch (error) {
            throw Object.assign(new NotesError("index_unavailable", "SQLite is unavailable in this Notes host."), { cause: error });
        }
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        // mkdir's mode only applies to directories it creates.
        if (process.platform !== "win32") await chmod(this.#directory, 0o700);
        const db = new sqlite.DatabaseSync(join(this.#directory, shadowIndexFile(root)), { timeout: BUSY_TIMEOUT_MS });
        try {
            db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
            db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT`);
            this.#statements = {
                signature: db.prepare("SELECT value FROM meta WHERE key = 'signature'"),
                setSignature: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('signature', ?)"),
                versions: db.prepare("SELECT path, version, mtime_ms FROM notes"),
                upsert: db.prepare("INSERT OR REPLACE INTO notes (path, version, mtime_ms, frontmatter, body, warning) VALUES (?, ?, ?, ?, ?, ?)"),
                remove: db.prepare("DELETE FROM notes WHERE path = ?"),
                folder: db.prepare("INSERT INTO folders (path) VALUES (?)"),
                warning: db.prepare("INSERT INTO warnings (path, code, message) VALUES (?, ?, ?)"),
            };
            this.#db = db;
        } catch (error) {
            try { db.close(); } catch { /* closing also discards an open transaction */ }
            throw error;
        }
    }

    // Rewrites only rows whose content version or modified time changed since the last scan by any process.
    #write(snapshot, signature) {
        const db = this.#db;
        const statements = this.#statements;
        if (statements.signature.get()?.value === signature) return;
        db.exec("BEGIN IMMEDIATE");
        try {
            const stale = new Map(statements.versions.all().map(row => [row.path, row]));
            for (const note of snapshot.notes) {
                const row = stale.get(note.path);
                stale.delete(note.path);
                if (row?.version === note.version && row.mtime_ms === note.stats.mtimeMs) continue;
                statements.upsert.run(note.path, note.version, note.stats.mtimeMs,
                    JSON.stringify(note.metadata), note.body, note.warning ? JSON.stringify(note.warning) : null);
            }
            for (const path of stale.keys()) statements.remove.run(path);
            db.exec("DELETE FROM folders; DELETE FROM warnings");
            for (const path of snapshot.folders) statements.folder.run(path);
            for (const { path, code, message } of snapshot.warnings) statements.warning.run(path, code, message);
            statements.setSignature.run(signature);
            db.exec("COMMIT");
        } catch (error) {
            try { db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back */ }
            throw error;
        }
    }

    #disable(error) {
        this.close();
        const code = failureCode(error);
        report(() => this.#log?.(`The local shadow index is disabled until Notes restarts (${code ?? "unexpected error"}). Notes continues to use its files.`, { level: "warning" }));
        report(() => this.#onFailure?.(error, code));
    }
}

// Reporting must never affect the Notes operation, whether it throws or rejects.
function report(callback) {
    try { void Promise.resolve(callback()).catch(() => {}); } catch { /* ignored */ }
}
