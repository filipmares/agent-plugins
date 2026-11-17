import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import { NotesError } from "./errors.mjs";
import { readLibrarySnapshot, snapshotSignature } from "./library-snapshot.mjs";
import { shadowIndexFile } from "./shadow-index.mjs";

const { root, directory } = workerData;
let db, statements;
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY, version TEXT NOT NULL, mtime_ms REAL NOT NULL,
        frontmatter TEXT NOT NULL, body TEXT NOT NULL, warning TEXT);
    CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS warnings (position INTEGER PRIMARY KEY, path TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL);`;

function failureCode(error) {
    switch (error?.errcode & 0xff) {
        case 5: case 6: return "index_busy";
        case 11: case 26: return "index_corrupt";
    }
    return error?.code ?? "index_unavailable";
}

async function open() {
    const location = relative(root, directory);
    if (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`)) {
        throw new NotesError("index_unavailable", "The index directory is inside the Notes library.");
    }
    let sqlite;
    try { sqlite = await import("node:sqlite"); } catch (error) {
        throw Object.assign(new NotesError("index_unavailable", "SQLite is unavailable in this Notes host."), { cause: error });
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    db = new sqlite.DatabaseSync(join(directory, shadowIndexFile(root)), { timeout: 1000 });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT`);
    statements = {
        reserve: db.prepare("INSERT INTO meta (key, value) VALUES ('issued', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value"),
        applied: db.prepare("SELECT value FROM meta WHERE key = 'applied'"),
        setApplied: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('applied', ?)"),
        signature: db.prepare("SELECT value FROM meta WHERE key = 'signature'"),
        setSignature: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('signature', ?)"),
        versions: db.prepare("SELECT path, version, mtime_ms FROM notes"),
        upsert: db.prepare("INSERT OR REPLACE INTO notes (path, version, mtime_ms, frontmatter, body, warning) VALUES (?, ?, ?, ?, ?, ?)"),
        remove: db.prepare("DELETE FROM notes WHERE path = ?"),
        folder: db.prepare("INSERT INTO folders (path) VALUES (?)"),
        warning: db.prepare("INSERT INTO warnings (path, code, message) VALUES (?, ?, ?)"),
    };
}

async function synchronize() {
    if (!statements) {
        db?.close();
        await open();
    }
    // Reserve ordering before reading files, without locking out other workers during discovery.
    const generation = statements.reserve.get().value;
    const snapshot = await readLibrarySnapshot(root, { retryConflicts: true });
    for (const note of snapshot.notes) {
        if (note.warning) snapshot.warnings.push({ path: note.path, ...note.warning });
    }
    const signature = snapshotSignature(snapshot);
    db.exec("BEGIN IMMEDIATE");
    try {
        // A slower, older discovery must not overwrite an already committed newer one.
        if (BigInt(generation) <= BigInt(statements.applied.get()?.value ?? "0")) {
            db.exec("ROLLBACK");
            return;
        }
        if (statements.signature.get()?.value !== signature) {
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
        }
        statements.setApplied.run(generation);
        db.exec("COMMIT");
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back */ }
        throw error;
    }
}

parentPort.on("message", async ({ type }) => {
    if (type === "close") {
        db?.close();
        parentPort.close();
        return;
    }
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { await synchronize(); break; } catch (error) {
                if (!["index_busy", "ENOENT", "not_found", "conflict"].includes(failureCode(error)) || Date.now() >= deadline) throw error;
                await delay(50);
            }
        }
        parentPort.postMessage({ type: "done" });
    } catch (error) {
        try { db?.close(); } catch { /* a failed transaction is discarded on exit */ }
        const code = failureCode(error);
        // A terminal index failure must not be filtered as an expected note conflict or validation error.
        parentPort.postMessage({ type: "failure",
            code: error instanceof NotesError && !code.startsWith("index_") ? "index_unavailable" : code,
            stack: error?.stack });
        parentPort.close();
    }
});
