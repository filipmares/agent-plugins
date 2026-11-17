import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import { NotesError } from "./errors.mjs";
import { readLibrarySnapshot, snapshotSignature } from "./library-snapshot.mjs";
import { activeIndexFile, rotateIndex } from "./index-location.mjs";
import { listNotes, searchText } from "./list-notes.mjs";
import { titleOf } from "./note-format.mjs";

const { root, directory } = workerData;
let db, statements, file, identity;
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY, version TEXT NOT NULL, mtime_ms REAL NOT NULL,
        frontmatter TEXT NOT NULL, body TEXT NOT NULL, warning TEXT,
        title TEXT NOT NULL, search_text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS warnings (position INTEGER PRIMARY KEY, path TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL);`;

function failureCode(error) {
    switch (error?.errcode & 0xff) {
        case 5: case 6: return "index_busy";
        case 11: case 26: return "index_corrupt";
    }
    return error?.code ?? "index_unavailable";
}

async function prepareDirectory() {
    const location = relative(root, directory);
    if (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`)) {
        throw new NotesError("index_unavailable", "The index directory is inside the Notes library.");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function open(nextFile) {
    let sqlite;
    try { sqlite = await import("node:sqlite"); } catch (error) {
        throw Object.assign(new NotesError("index_unavailable", "SQLite is unavailable in this Notes host."), { cause: error });
    }
    await prepareDirectory();
    const path = join(directory, nextFile);
    db = new sqlite.DatabaseSync(path, { timeout: 1000 });
    identity = await lstat(path, { bigint: true });
    file = nextFile;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    db.exec(`BEGIN IMMEDIATE; ${SCHEMA} COMMIT`);
    statements = {
        reserve: db.prepare("INSERT INTO meta (key, value) VALUES ('issued', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value"),
        applied: db.prepare("SELECT value FROM meta WHERE key = 'applied'"),
        setApplied: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('applied', ?)"),
        signature: db.prepare("SELECT value FROM meta WHERE key = 'signature'"),
        settledSignature: db.prepare(`SELECT value FROM meta WHERE key = 'signature' AND
            (SELECT value FROM meta WHERE key = 'issued') = (SELECT value FROM meta WHERE key = 'applied')`),
        setSignature: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('signature', ?)"),
        setSynchronized: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('synchronized', ?)"),
        versions: db.prepare("SELECT path, version, mtime_ms FROM notes"),
        upsert: db.prepare("INSERT OR REPLACE INTO notes (path, version, mtime_ms, frontmatter, body, warning, title, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
        remove: db.prepare("DELETE FROM notes WHERE path = ?"),
        folder: db.prepare("INSERT INTO folders (path) VALUES (?)"),
        warning: db.prepare("INSERT INTO warnings (path, code, message) VALUES (?, ?, ?)"),
        list: db.prepare("SELECT path, version, mtime_ms, frontmatter, warning, title, search_text FROM notes"),
        warnings: db.prepare("SELECT path, code, message FROM warnings ORDER BY position"),
    };
}

async function synchronize(verifiedSignature) {
    const nextFile = await activeIndexFile(root, directory);
    if (!statements || !await isCurrent(nextFile)) {
        db?.close();
        db = undefined;
        statements = undefined;
        await open(nextFile);
    }
    // A confirmed cache hit needs no second scan, unless an in-flight discovery needs fencing.
    if (verifiedSignature !== undefined && statements.settledSignature.get()?.value === verifiedSignature) return;
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
                    JSON.stringify(note.metadata), note.body, note.warning ? JSON.stringify(note.warning) : null,
                    note.metadata.title ?? titleOf(note.body), searchText(note));
            }
            for (const path of stale.keys()) statements.remove.run(path);
            db.exec("DELETE FROM folders; DELETE FROM warnings");
            for (const path of snapshot.folders) statements.folder.run(path);
            for (const { path, code, message } of snapshot.warnings) statements.warning.run(path, code, message);
            statements.setSignature.run(signature);
        }
        statements.setApplied.run(generation);
        statements.setSynchronized.run(new Date().toISOString());
        db.exec("COMMIT");
    } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back */ }
        throw error;
    }
}

function details() {
    return {
        file,
        synchronized: db.prepare("SELECT value FROM meta WHERE key = 'synchronized'").get()?.value ?? null,
        notes: db.prepare("SELECT count(*) AS count FROM notes").get().count,
        warnings: db.prepare("SELECT count(*) AS count FROM warnings").get().count,
    };
}

async function isCurrent(active) {
    if (active !== file) return false;
    const current = await lstat(join(directory, active), { bigint: true }).catch(error => {
        if (error.code !== "ENOENT") throw error;
    });
    return current?.isFile() && current.dev === identity.dev && current.ino === identity.ino;
}

async function list(signature, filters) {
    const connection = db;
    if (!await isCurrent(await activeIndexFile(root, directory))) return { reopen: true };
    if (db !== connection || !statements) return {};
    // Another session may commit between statements; match and read the same SQLite snapshot.
    db.exec("BEGIN");
    try {
        if (statements.signature.get()?.value !== signature) return {};
        function* notes() {
            for (const row of statements.list.iterate()) {
                yield {
                    path: row.path, version: row.version, stats: { mtimeMs: row.mtime_ms }, metadata: JSON.parse(row.frontmatter),
                    warning: JSON.parse(row.warning), title: row.title, text: row.search_text,
                };
            }
        }
        return { result: listNotes({ notes: notes(), warnings: statements.warnings.all() }, filters) };
    } finally { db.exec("ROLLBACK"); }
}

parentPort.on("message", async ({ type, signature, filters }) => {
    if (type === "close") {
        db?.close();
        db = undefined;
        parentPort.close();
        return;
    }
    try {
        if (type === "list") {
            parentPort.postMessage({ type: "listed", ...await list(signature, filters) });
            return;
        }
        if (type === "rebuild") {
            await prepareDirectory();
            await rotateIndex(root, directory);
        }
        const deadline = Date.now() + 30000;
        for (;;) {
            try {
                await synchronize(signature);
                if (type !== "refresh") {
                    if (db.prepare("PRAGMA quick_check").all().some(row => Object.values(row)[0] !== "ok")) {
                        throw new NotesError("index_corrupt", "The index integrity check failed.");
                    }
                }
                // A concurrent rebuild may have switched the shared cache during discovery.
                if (file !== await activeIndexFile(root, directory)) {
                    if (Date.now() >= deadline) throw new NotesError("index_busy", "Another session is rebuilding the index.");
                    continue;
                }
                break;
            } catch (error) {
                if (!["index_busy", "ENOENT", "not_found", "conflict"].includes(failureCode(error)) || Date.now() >= deadline) throw error;
                await delay(50);
            }
        }
        parentPort.postMessage({ type: "done", details: details(), checked: type !== "refresh" });
    } catch (error) {
        if (type === "list" && failureCode(error) === "index_busy") {
            parentPort.postMessage({ type: "listed" });
            return;
        }
        try { db?.close(); } catch { /* a failed transaction is discarded on exit */ }
        const code = failureCode(error);
        // A terminal index failure must not be filtered as an expected note conflict or validation error.
        parentPort.postMessage({ type: "failure",
            code: error instanceof NotesError && !code.startsWith("index_") ? "index_unavailable" : code,
            stack: error?.stack });
        parentPort.close();
    }
});
