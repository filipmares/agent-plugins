import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import { FailureJournal } from "../failure-journal.mjs";
import { retryTransient } from "../filesystem.mjs";
import * as filesystem from "../filesystem.mjs";
import { NotesError } from "../errors.mjs";
import { readLibrarySnapshot } from "../library-snapshot.mjs";
import { ULID } from "../note-format.mjs";
import { ShadowIndex, shadowIndexFile } from "../shadow-index.mjs";
import { activeIndexFile } from "../index-location.mjs";
import { NotesLibrary } from "../storage.mjs";

const execute = promisify(execFile);
const author = { sessionId: "session-a", actor: "agent" };
let fixture, root, indexDirectory, library, index, failures, logs;

const trash = async path => {
    await mkdir(join(fixture, "trash"), { recursive: true });
    await retryTransient(() => rename(path, join(fixture, "trash", basename(path))));
};
const indexed = (options = {}) => new NotesLibrary(root, {
    trash,
    index: index = new ShadowIndex({
        directory: indexDirectory,
        log: (message, details) => logs.push({ message, ...details }),
        onFailure: (error, code) => failures.push(code),
        ...options,
    }),
});
const indexPath = async () => join(indexDirectory, await activeIndexFile(await realpath(root), indexDirectory));

async function write(path, content) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
}

async function withIndex(read) {
    await index.flush();
    const db = new DatabaseSync(await indexPath());
    try { return read(db); } finally { db.close(); }
}

function auditWrites(db) {
    db.exec(`CREATE TABLE test_writes (path TEXT);
        CREATE TRIGGER test_insert AFTER INSERT ON notes BEGIN INSERT INTO test_writes VALUES (NEW.path); END;
        CREATE TRIGGER test_delete AFTER DELETE ON notes BEGIN INSERT INTO test_writes VALUES (OLD.path); END;`);
    return () => db.prepare("SELECT count(*) AS count FROM test_writes").get().count;
}

const contents = () => withIndex(db => ({
    signature: db.prepare("SELECT value FROM meta WHERE key = 'signature'").get()?.value,
    notes: db.prepare("SELECT path, version, mtime_ms, frontmatter, body, warning FROM notes ORDER BY path").all().map(row => ({
        ...row, frontmatter: JSON.parse(row.frontmatter), warning: JSON.parse(row.warning),
    })),
    folders: db.prepare("SELECT path FROM folders ORDER BY path").all().map(row => row.path),
    warnings: db.prepare("SELECT path, code, message FROM warnings ORDER BY position").all().map(row => ({ ...row })),
}));

// Expected rows come from the production read path of a library without an index.
async function production() {
    const plain = new NotesLibrary(root);
    const { notes, warnings } = await plain.search({ limit: 100 });
    const rows = await Promise.all(notes.map(async item => {
        const note = await plain.read(item.path);
        return {
            path: note.path,
            version: note.version,
            mtime_ms: (await lstat(join(root, ...note.path.split("/")))).mtimeMs,
            frontmatter: note.frontmatter,
            body: note.body,
            warning: note.warning ?? null,
        };
    }));
    return { notes: rows.sort((a, b) => a.path < b.path ? -1 : 1), warnings };
}

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-index-"));
    root = join(fixture, "notes");
    indexDirectory = join(fixture, "index");
    await mkdir(root);
    failures = [];
    logs = [];
    library = indexed();
});

afterEach(async () => {
    await library.close();
    await rm(fixture, { recursive: true, force: true });
});

test("mirrors the production scan, including adopted metadata, raw warned notes, folders and warnings", async () => {
    const created = await library.create({ body: "# Plan\nneedle", folder: "Work" }, author);
    await write("plain.md", "# Plain\nNo frontmatter yet");
    await write("broken.md", "---\ntitle: [broken\n---\n# Broken");
    await write("binary.md", Buffer.from([0xff, 0xfe, 0x00]));
    await mkdir(join(root, "Empty"));
    await library.search();

    const actual = await contents();
    const expected = await production();
    expect(actual.notes).toEqual(expected.notes);
    expect(actual.warnings).toEqual(expected.warnings);
    expect(actual.warnings.map(item => [item.path, item.code])).toEqual([["binary.md", "invalid_encoding"], ["broken.md", "invalid_frontmatter"]]);
    expect(actual.folders).toEqual(["", "Empty", "Work"]);
    expect(actual.notes.find(row => row.path === "plain.md").frontmatter.id).toMatch(ULID);
    expect(actual.notes.find(row => row.path === "Work/plan.md").frontmatter.id).toBe(created.id);
    expect(actual.notes.find(row => row.path === "broken.md").body).toBe("---\ntitle: [broken\n---\n# Broken");
    expect(failures).toEqual([]);
});

test("watched list and search use SQLite with identical summaries, snippets, ranking and filters", async () => {
    const body = "# Body heading\n" + "😀 ".repeat(100) + "\n[Résumé](https://example.test/hiddentarget) has needle.";
    await library.create({ body, folder: "Work" }, { ...author, project: "sample" });
    const title = await library.create({ body: "# Needle\nOther text" }, author);
    await library.pin(title.id, true, title.version);
    await write("broken.md", "---\ntitle: [broken\n---\n# Needle");
    await write("binary.md", Buffer.from([0xff, 0xfe, 0x00]));
    await library.startWatching(() => {}, { intervalMs: 3600000 });
    await index.flush();
    const read = spyOn(index, "list");
    const plain = new NotesLibrary(root);
    try {
        for (const filters of [{}, { query: "needle" }, { query: "resume body", session: author.sessionId },
            { query: "hiddentarget" }, { query: "[broken" }, { folder: "Work" }, { project: "sample" }]) {
            const result = await library.list(filters);
            expect(result).toEqual(await plain.list(filters));
            expect(await read.mock.results.at(-1).value).toEqual(result);
        }
        const results = await library.search({ query: "needle", limit: 1 });
        expect(results).toEqual(await plain.search({ query: "needle", limit: 1 }));
        expect(results.nextOffset).toBe(1);
    } finally { read.mockRestore(); }
});

test("a different committed snapshot or missing active database falls back to watched Markdown", async () => {
    const note = await library.create({ body: "# Kept\nneedle" }, author);
    await library.startWatching(() => {}, { intervalMs: 3600000 });
    const expected = await library.list({ query: "needle" });
    const read = spyOn(index, "list");
    try {
        await withIndex(db => db.exec("DELETE FROM notes; UPDATE meta SET value = 'different snapshot' WHERE key = 'signature'"));
        expect(await library.list({ query: "needle" })).toEqual(expected);
        expect(await read.mock.results.at(-1).value).toBeUndefined();
        await writeFile(join(indexDirectory, `${shadowIndexFile(await realpath(root))}.active`), "a".repeat(36));
        expect((await library.list()).notes.map(item => item.id)).toEqual([note.id]);
        expect(await read.mock.results.at(-1).value).toBeUndefined();
        await index.flush();
        const reopened = await library.list({ query: "needle" });
        expect(await read.mock.results.at(-1).value).toEqual(expected);
        expect(reopened).toEqual(expected);
    } finally { read.mockRestore(); }
});

test("a timed-out list uses Markdown without queueing SQLite queries behind the stalled one", async () => {
    await library.close();
    const worker = Object.assign(new EventEmitter(), {
        postMessage: message => {
            if (message.type === "refresh") queueMicrotask(() => worker.emit("message", { type: "done" }));
            if (message.type === "list") queries++;
            if (message.type === "close") queueMicrotask(() => worker.emit("exit"));
        },
        ref() {}, unref() {},
    });
    let queries = 0;
    library = indexed({ createWorker: () => worker });
    await write("kept.md", "# Kept\nneedle");
    await library.startWatching(() => {}, { intervalMs: 3600000 });
    await index.flush();
    const expected = await new NotesLibrary(root).list({ query: "needle" });
    expect(await library.list({ query: "needle" })).toEqual(expected);
    expect(await library.list({ query: "needle" })).toEqual(expected);
    expect(queries).toBe(1);
    worker.emit("message", { type: "listed" });
    expect(await library.list({ query: "needle" })).toEqual(expected);
    expect(queries).toBe(2);
});

test("reads the new Markdown snapshot while a watched deletion is pending in the worker", async () => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    await library.close();
    let holdRefresh = false;
    library = indexed({ createWorker: options => {
        const worker = new Worker(new URL("../index-worker.mjs", import.meta.url), options);
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message, transfer) => {
            if (holdRefresh && message.type === "refresh") void gate.then(() => post(message, transfer));
            else post(message, transfer);
        };
        return worker;
    } });
    try {
        const note = await library.create({ body: "# Deleted\nneedle" }, author);
        await library.startWatching(() => {}, { intervalMs: 3600000 });
        await index.flush();
        holdRefresh = true;
        await library.delete(note.id, { expectedVersion: note.version });
        expect(library.indexStatus().state).toBe("syncing");
        expect((await library.search({ query: "needle" })).total).toBe(0);
        expect((await library.list()).notes).toEqual([]);
    } finally { release(); }
    await index.flush();
    expect((await contents()).notes).toEqual([]);
});

test("follows edits, moves, external changes and deletions, and skips unchanged scans", async () => {
    const first = await library.create({ body: "# First" }, author);
    const second = await library.create({ body: "# Second" }, author);
    const third = await library.create({ body: "# Third" }, author);
    await library.search();
    await index.flush();
    const reader = new DatabaseSync(await indexPath());
    try {
        const writes = auditWrites(reader);
        await library.search();
        await library.read(first.id);
        await index.flush();
        expect(writes()).toBe(0);

        await library.update(first.id, { body: "# First\nedited", expectedVersion: first.version }, author);
        await mkdir(join(root, "Archive"));
        await library.move(second.id, { folder: "Archive", expectedVersion: second.version });
        await library.delete(third.id, { expectedVersion: third.version });
        await write("external.md", "---\nid: 01J0000000000000000000000A\n---\n# External");
        await library.search();
        await index.flush();
        expect(writes()).toBeGreaterThan(0);
    } finally { reader.close(); }

    const actual = await contents();
    expect(actual.notes).toEqual((await production()).notes);
    expect(actual.notes.map(row => row.path)).toEqual(["Archive/second.md", "external.md", "first.md"]);
    expect(actual.folders).toEqual(["", "Archive"]);
});

test("reopens without rewriting and rebuilds identical contents after the index is deleted", async () => {
    await library.create({ body: "# Kept\ntext", folder: "Work" }, author);
    await write("broken.md", "---\n: [\n---\n");
    await library.search();
    const built = await contents();
    await library.close();

    const reader = new DatabaseSync(await indexPath());
    try {
        const writes = auditWrites(reader);
        library = indexed();
        await library.search();
        await index.flush();
        expect(writes()).toBe(0);
    } finally { reader.close(); }
    await library.close();

    await rm(indexDirectory, { recursive: true });
    library = indexed();
    await library.search();
    expect(await contents()).toEqual(built);
    expect(failures).toEqual([]);
});

test("processes sharing one index leave it at the latest completed scan", async () => {
    const script = `import { NotesLibrary } from ${JSON.stringify(new URL("../storage.mjs", import.meta.url).href)};
        import { ShadowIndex } from ${JSON.stringify(new URL("../shadow-index.mjs", import.meta.url).href)};
        const failures = [];
        const library = new NotesLibrary(process.argv[1], { index: new ShadowIndex({ directory: process.argv[2], onFailure: (error, code) => failures.push(code) }) });
        await library.create({ body: "# " + process.argv[3] }, { sessionId: process.argv[3], actor: "agent" });
        await library.search();
        await library.close();
        process.stdout.write(JSON.stringify(failures));`;
    const outputs = await Promise.all(["alpha", "beta", "gamma"].map(async name =>
        (await execute(process.execPath, ["-e", script, root, indexDirectory, name])).stdout));
    expect(outputs).toEqual(["[]", "[]", "[]"]);
    const actual = await contents();
    expect(actual.notes).toEqual((await production()).notes);
    expect(actual.notes.map(row => row.path)).toEqual(["alpha.md", "beta.md", "gamma.md"]);
}, 15000);

test("a delayed discovery cannot overwrite a newer committed generation", async () => {
    await library.create({ body: "# First" }, author);
    await index.flush();
    for (let offset = 0; offset < 500; offset += 50) {
        await Promise.all(Array.from({ length: 50 }, (_, i) => writeFile(join(root, `note-${offset + i}.md`), "# Synthetic")));
    }
    const other = new DatabaseSync(await indexPath());
    try {
        const generation = () => BigInt(other.prepare("SELECT value FROM meta WHERE key = 'issued'").get().value);
        const before = generation();
        index.refresh(await realpath(root));
        const deadline = Date.now() + 4000;
        while (generation() === before) {
            if (Date.now() > deadline) throw new Error("The worker did not reserve a generation.");
            await delay(1);
        }
        other.exec("BEGIN IMMEDIATE");
        const issued = generation();
        expect(BigInt(other.prepare("SELECT value FROM meta WHERE key = 'applied'").get().value)).toBe(before);
        // A second session finishes a newer generation while the first is still discovering files.
        other.prepare("UPDATE meta SET value = ? WHERE key IN ('issued', 'applied')").run(String(issued + 1n));
        other.exec("UPDATE notes SET body = 'newer commit'; UPDATE meta SET value = 'newer' WHERE key = 'signature'; COMMIT");
        await index.flush();
        expect((await contents()).notes.map(row => row.body)).toEqual(["newer commit"]);
        expect((await contents()).signature).toBe("newer");
        index.refresh(await realpath(root));
        expect((await contents()).notes).toHaveLength(501);
    } finally { other.close(); }
});

test("an unchanged newer discovery still fences off older generations without rewriting note rows", async () => {
    await library.create({ body: "# First" }, author);
    await index.flush();
    const observer = new DatabaseSync(await indexPath());
    try {
        const writes = auditWrites(observer);
        const applied = () => observer.prepare("SELECT value FROM meta WHERE key = 'applied'").get().value;
        const before = BigInt(applied());
        const rootPath = await realpath(root);
        const { signature } = await contents();
        index.refresh(rootPath, signature);
        await index.flush();
        expect(BigInt(applied())).toBe(before);
        observer.prepare("UPDATE meta SET value = ? WHERE key = 'issued'").run(String(before + 1n));
        index.refresh(rootPath, signature);
        await index.flush();
        expect(BigInt(applied())).toBeGreaterThan(before + 1n);
        expect(applied()).toBe(observer.prepare("SELECT value FROM meta WHERE key = 'issued'").get().value);
        expect(writes()).toBe(0);
    } finally { observer.close(); }
});

test("unavailable workers are reported once and Notes keeps working, even if logging throws", async () => {
    await library.close();
    library = indexed({
        log: () => { throw new Error("session closed"); },
        createWorker: () => { throw new Error("Workers unavailable"); },
    });
    await library.create({ body: "# Works" }, author);
    expect((await library.search()).notes.map(note => note.path)).toEqual(["works.md"]);
    expect(failures).toEqual(["index_unavailable"]);
    await expect(lstat(indexDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("settings retries a failed worker and reports completion only after a real integrity check", async () => {
    await library.close();
    let unavailable = true;
    library = indexed({ createWorker: options => {
        if (unavailable) throw new Error("Worker unavailable");
        return new Worker(new URL("../index-worker.mjs", import.meta.url), options);
    } });
    const note = await library.create({ body: "# Safe" }, author);
    expect(library.indexStatus()).toMatchObject({ state: "degraded", error: "index_unavailable", checked: null });
    unavailable = false;
    expect(await library.manageIndex("check")).toMatchObject({ state: "checking", checked: null });
    await expect(library.manageIndex("rebuild")).rejects.toMatchObject({ code: "index_busy" });
    await index.flush();
    expect(library.indexStatus()).toMatchObject({
        state: "idle", error: null, checked: expect.any(String),
        details: { synchronized: expect.any(String), notes: 1, warnings: 0 },
    });
    expect((await library.read(note.id)).version).toBe(note.version);
    await expect(library.manageIndex("sql")).rejects.toMatchObject({ code: "invalid_request" });
});

test("retrying a slow worker termination never holds the Markdown write lock", async () => {
    await library.close();
    let release;
    const terminating = new Promise(resolve => release = resolve);
    library = indexed({ createWorker: () => Object.assign(new EventEmitter(), {
        ref() {}, unref() {},
        postMessage() { queueMicrotask(() => this.emit("message", { type: "failure", code: "index_unavailable" })); },
        terminate: () => terminating,
    }) });
    await library.create({ body: "# Before" }, author);
    await index.flush();
    const retry = library.manageIndex("check");
    try {
        while (!index.status().managing) await delay(1);
        const saved = await Promise.race([
            library.create({ body: "# During retry" }, author),
            delay(1000).then(() => { throw new Error("Index recovery blocked Markdown writes."); }),
        ]);
        expect(saved.path).toBe("during-retry.md");
    } finally { release(); await retry; await index.flush(); }
});

test("a malformed generation pointer is reported and rebuild repairs it without following paths", async () => {
    await mkdir(indexDirectory);
    const pointer = join(indexDirectory, `${shadowIndexFile(await realpath(root))}.active`);
    await writeFile(pointer, "../outside.sqlite");
    await library.create({ body: "# Safe" }, author);
    await index.flush();
    expect(index.status()).toMatchObject({ state: "degraded", error: "index_unavailable" });
    await library.manageIndex("rebuild");
    await index.flush();
    expect(index.status()).toMatchObject({ state: "idle", error: null, details: { notes: 1 } });
    expect(await readdir(fixture)).toEqual(expect.arrayContaining(["index", "notes"]));
    await expect(lstat(join(fixture, "outside.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("rebuild recovers corruption without replacing a live database and other workers adopt it", async () => {
    const note = await library.create({ body: "# Kept\ntext" }, author);
    await index.flush();
    const oldPath = await indexPath();
    const reader = new DatabaseSync(oldPath);
    const other = new ShadowIndex({ directory: indexDirectory });
    try {
        other.refresh(await realpath(root));
        await other.flush();
        await library.close();
        // A corrupt active cache may coexist with a connection still using an older cache.
        const corrupt = `${shadowIndexFile(await realpath(root))}.active`;
        await writeFile(join(indexDirectory, corrupt), "00000000-0000-0000-0000-000000000000");
        const corruptPath = await indexPath();
        const garbage = "not sqlite ".repeat(100);
        await writeFile(corruptPath, garbage);
        library = indexed();
        await library.search();
        await index.flush();
        expect(library.indexStatus().error).toBe("index_corrupt");
        expect(await library.manageIndex("rebuild")).toMatchObject({ state: "rebuilding", error: null, checked: null });
        await index.flush();
        expect(library.indexStatus()).toMatchObject({ state: "idle", error: null, details: { notes: 1 } });
        expect(await indexPath()).not.toBe(corruptPath);
        expect(await readFile(corruptPath, "utf8")).toBe(garbage);
        expect(reader.prepare("SELECT body FROM notes").get().body).toBe("# Kept\ntext");
        expect((await library.read(note.id)).version).toBe(note.version);
        other.refresh(await realpath(root));
        await other.flush();
        expect(other.status().details.file).toBe(index.status().details.file);
        expect((await contents()).notes).toEqual((await production()).notes);
    } finally { reader.close(); await other.close(); }
});

test("concurrent rebuilds converge without unlinking caches held by live sessions", async () => {
    await library.create({ body: "# Shared" }, author);
    await index.flush();
    const oldPath = await indexPath();
    const reader = new DatabaseSync(oldPath);
    const other = new ShadowIndex({ directory: indexDirectory });
    try {
        const rootPath = await realpath(root);
        await Promise.all([library.manageIndex("rebuild"), other.manage(rootPath, "rebuild")]);
        await Promise.all([index.flush(), other.flush()]);
        // A later observation follows the winner even when the earlier rebuild finished first.
        await Promise.all([library.manageIndex("check"), other.manage(rootPath, "check")]);
        await Promise.all([index.flush(), other.flush()]);
        expect(index.status()).toMatchObject({ state: "idle", error: null });
        expect(other.status()).toMatchObject({ state: "idle", error: null });
        expect(index.status().details.file).toBe(other.status().details.file);
        expect(reader.prepare("SELECT count(*) AS count FROM notes").get().count).toBe(1);
        expect((await contents()).notes).toEqual((await production()).notes);
    } finally { reader.close(); await other.close(); }
});

test("separate processes can rebuild the shared cache while an existing connection stays usable", async () => {
    await library.create({ body: "# Shared" }, author);
    await index.flush();
    const reader = new DatabaseSync(await indexPath());
    const script = `import { ShadowIndex } from ${JSON.stringify(new URL("../shadow-index.mjs", import.meta.url).href)};
        const index = new ShadowIndex({ directory: process.argv[2] });
        await index.manage(process.argv[1], "rebuild");
        await index.flush();
        process.stdout.write(JSON.stringify(index.status()));
        await index.close();`;
    try {
        const results = await Promise.all([1, 2].map(async () =>
            JSON.parse((await execute(process.execPath, ["-e", script, await realpath(root), indexDirectory])).stdout)));
        expect(results.map(status => status.state)).toEqual(["idle", "idle"]);
        expect(reader.prepare("SELECT count(*) AS count FROM notes").get().count).toBe(1);
        await library.manageIndex("check");
        await index.flush();
        expect(index.status().details.file).toBe(await activeIndexFile(await realpath(root), indexDirectory));
        expect((await contents()).notes).toEqual((await production()).notes);
    } finally { reader.close(); }
}, 15000);

test("an index directory inside the Notes library is refused before anything is written there", async () => {
    await library.close();
    const inside = join(await realpath(root), "copilot-home", "index");
    library = indexed({ directory: inside });
    await library.create({ body: "# Works" }, author);
    expect((await library.search()).notes.map(note => note.path)).toEqual(["works.md"]);
    await index.flush();
    expect(failures).toEqual(["index_unavailable"]);
    await expect(lstat(join(root, "copilot-home"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unsafe worker library is degraded as an index failure, not filtered as expected note validation", async () => {
    const original = join(fixture, "original");
    await rename(root, original);
    await symlink(original, root, "junction");
    index.refresh(root);
    await index.flush();
    expect(failures).toEqual(["index_unavailable"]);
});

test.skipIf(process.platform === "win32")("an existing index directory is made owner-only", async () => {
    await library.close();
    await mkdir(indexDirectory, { recursive: true });
    await chmod(indexDirectory, 0o755);
    library = indexed();
    await library.search();
    await index.flush();
    expect((await lstat(indexDirectory)).mode & 0o777).toBe(0o700);
    expect(failures).toEqual([]);
});

test("closing immediately drains queued work and never reopens the worker", async () => {
    await library.create({ body: "# Kept" }, author);
    await library.close();
    expect((await contents()).notes.map(row => row.path)).toEqual(["kept.md"]);
    await rm(indexDirectory, { recursive: true });
    index.refresh(await realpath(root));
    await index.flush();
    await expect(lstat(indexDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("bursts coalesce to one active and one pending root invalidation without snapshot cloning", async () => {
    await library.close();
    const messages = [];
    library = indexed({ createWorker: options => {
        expect(Object.keys(options.workerData).sort()).toEqual(["directory", "root"]);
        const worker = new Worker(new URL("../index-worker.mjs", import.meta.url), options);
        const post = worker.postMessage.bind(worker);
        worker.postMessage = message => { messages.push(message); post(message); };
        return worker;
    } });
    const canonical = await realpath(root);
    for (let count = 0; count < 1000; count++) index.refresh(canonical);
    expect(messages).toEqual([{ type: "refresh" }]);
    await index.flush();
    expect(messages).toEqual([{ type: "refresh" }, { type: "refresh" }]);
});

test("a stuck worker is terminated on bounded shutdown and degraded once", async () => {
    await library.close();
    library = indexed({
        createWorker: () => new Worker(new URL(`data:text/javascript,${encodeURIComponent(
            "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {});",
        )}`)),
    });
    await library.create({ body: "# Safe" }, author);
    const started = performance.now();
    await library.close();
    expect(performance.now() - started).toBeLessThan(32000);
    expect(failures).toEqual(["index_unavailable"]);
    expect((await library.read("safe.md")).body).toBe("# Safe");
}, 35000);

test("a healthy 10k-note build drains during shutdown", async () => {
    const body = "# Synthetic\n" + "text ".repeat(200);
    for (let offset = 0; offset < 10000; offset += 100) {
        await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(root, `note-${offset + i}.md`), body)));
    }
    index.refresh(await realpath(root));
    await library.close();
    expect(await withIndex(db => db.prepare("SELECT count(*) AS count FROM notes").get().count)).toBe(10000);
    expect(failures).toEqual([]);
}, 35000);

test("background discovery rejects unstable reads instead of committing omissions, while production keeps warnings", async () => {
    await write("first.md", "# First");
    const conflict = new NotesError("conflict", "The note changed while reading it.");
    const read = spyOn(filesystem, "readNoteFile").mockRejectedValue(conflict);
    try {
        const snapshot = await readLibrarySnapshot(await realpath(root));
        expect(snapshot.warnings.map(item => item.code)).toEqual(["conflict"]);
        await expect(readLibrarySnapshot(await realpath(root), { retryConflicts: true })).rejects.toBe(conflict);
    } finally { read.mockRestore(); }
});

test("shutdown drains a watcher scan before closing its index", async () => {
    const note = await library.create({ body: "# First" }, author);
    await library.startWatching(() => {}, { intervalMs: 3600000, debounceMs: 10 });
    await index.flush();
    let release, reached;
    const gate = new Promise(resolve => release = resolve);
    const reading = new Promise(resolve => reached = resolve);
    const original = filesystem.readNoteFile;
    const read = spyOn(filesystem, "readNoteFile").mockImplementationOnce(async (...args) => {
        reached();
        await gate;
        return original(...args);
    });
    try {
        await write(note.path, "# External");
        await reading;
        let closed = false;
        const closing = library.close().then(() => closed = true);
        await delay(20);
        expect(closed).toBe(false);
        release();
        await closing;
        expect((await contents()).notes[0].body).toBe("# External");
        expect(failures).toEqual([]);
    } finally { release(); read.mockRestore(); }
});

test("a corrupt index is journaled and left untouched while Notes keeps working", async () => {
    const journal = new FailureJournal({ path: join(fixture, "journal.jsonl") });
    let recorded;
    await library.close();
    library = indexed({
        onFailure: (error, errorCode) => recorded = journal.recordFailure({
            eventName: "notes.index.degraded", errorCode, severityText: "WARN", attributes: { component: "index" }, stack: error?.stack,
        }),
    });
    await mkdir(indexDirectory);
    const garbage = "not a database ".repeat(100);
    await writeFile(await indexPath(), garbage);
    const note = await library.create({ body: "# Safe\ntext" }, author);
    expect((await library.read(note.id)).body).toBe("# Safe\ntext");
    await index.flush();
    expect(await recorded).toBe(true);

    const records = (await readFile(join(fixture, "journal.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toEqual([expect.objectContaining({
        eventName: "notes.index.degraded",
        severityText: "WARN",
        attributes: expect.objectContaining({ component: "index", errorCode: "index_corrupt" }),
        occurrences: 1,
    })]);
    expect(await readFile(await indexPath(), "utf8")).toBe(garbage);
    expect(await readdir(root)).toEqual(["safe.md"]);
});

test("busy waits stay off the request event loop and retry without holding the library lock", async () => {
    await library.close();
    library = indexed({ log: (message, details) => { logs.push({ message, ...details }); return Promise.reject(new Error("session closed")); } });
    await library.create({ body: "# Before" }, author);
    await library.search();
    await index.flush();
    const blocker = new DatabaseSync(await indexPath());
    try {
        blocker.exec("BEGIN IMMEDIATE");
        await write("after.md", "---\nid: 01J0000000000000000000000B\n---\n# After");
        const started = performance.now();
        expect((await library.search()).total).toBe(2);
        const note = await library.read("before.md");
        await library.update(note.id, { body: "# Before\nsaved", expectedVersion: note.version }, author);
        expect((await library.list()).notes.length).toBe(2);
        // A synchronous busy_timeout on this thread would prevent the timer firing.
        await delay(1200);
        expect(performance.now() - started).toBeLessThan(1900);
        expect(failures).toEqual([]);
        blocker.exec("ROLLBACK");
    } finally { blocker.close(); }
    await library.search();
    await index.flush();
    expect(failures).toEqual([]);
    expect((await contents()).notes.map(row => row.path)).toEqual(["after.md", "before.md"]);
});

test("mutations synchronize without any subsequent production rescan", async () => {
    const first = await library.create({ body: "# First" }, author);
    expect((await contents()).notes.map(row => row.path)).toEqual(["first.md"]);
    const edited = await library.update(first.id, { body: "# First\nsaved", expectedVersion: first.version }, author);
    expect((await contents()).notes[0].body).toBe("# First\nsaved");
    await library.createFolder("Archive");
    const moved = await library.move(edited.id, { folder: "Archive", expectedVersion: edited.version });
    expect((await contents()).notes.map(row => row.path)).toEqual(["Archive/first.md"]);
    const tree = await library.folders();
    await library.renameFolder("Archive", "Done", tree.folders.children.find(folder => folder.path === "Archive").version);
    expect((await contents()).notes.map(row => row.path)).toEqual(["Done/first.md"]);
    await library.delete(moved.id, { expectedVersion: moved.version });
    expect((await contents()).notes).toEqual([]);
});

test("a successful watched mutation enqueues only one refresh", async () => {
    await library.startWatching(() => {}, { intervalMs: 3600000 });
    await index.flush();
    const refresh = spyOn(index, "refresh");
    try {
        await library.create({ body: "# First" }, author);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect((await contents()).notes.map(row => row.path)).toEqual(["first.md"]);
    } finally { refresh.mockRestore(); }
});

test("a failed post-mutation watcher scan still invalidates the index", async () => {
    await library.startWatching(() => {}, { intervalMs: 3600000 });
    await index.flush();
    const original = filesystem.readNoteFile;
    const failure = new Error("scan failed");
    const read = spyOn(filesystem, "readNoteFile")
        .mockImplementationOnce((...args) => original(...args))
        .mockRejectedValueOnce(failure);
    const refresh = spyOn(index, "refresh");
    try {
        await expect(library.create({ body: "# First" }, author)).rejects.toBe(failure);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect((await contents()).notes.map(row => row.path)).toEqual(["first.md"]);
    } finally { read.mockRestore(); refresh.mockRestore(); }
});

test("external edits, renames and deletions synchronize through watcher events, not the periodic fallback", async () => {
    const first = await library.create({ body: "# First" }, author);
    let change;
    const changed = () => new Promise(resolve => change = resolve);
    await library.startWatching(() => change?.(), { intervalMs: 3600000, debounceMs: 10 });
    let notification = changed();
    await write("external.md", "# External");
    await notification;
    expect((await contents()).notes.map(row => row.path)).toEqual(["external.md", "first.md"]);
    notification = changed();
    await write(first.path, "---\ntitle: [broken\n---\n# Changed");
    await notification;
    expect((await contents()).notes.find(row => row.path === first.path).warning.code).toBe("invalid_frontmatter");
    notification = changed();
    await rename(join(root, "external.md"), join(root, "renamed.md"));
    await notification;
    expect((await contents()).notes.map(row => row.path)).toEqual(["first.md", "renamed.md"]);
    notification = changed();
    await rm(join(root, "renamed.md"));
    await notification;
    expect((await contents()).notes.map(row => row.path)).toEqual(["first.md"]);
});

test.each(["throw new Error('worker crash')", "process.exit(0)"])("worker failure degrades once and requests keep using files: %s", async script => {
    await library.close();
    library = indexed({
        createWorker: () => new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`)),
        log: () => Promise.reject(new Error("logger closed")),
    });
    const note = await library.create({ body: "# Safe" }, author);
    await index.flush();
    expect(failures).toHaveLength(1);
    expect((await library.list({ query: "safe" })).notes.map(item => item.id)).toEqual([note.id]);
    expect((await library.read(note.id)).body).toBe("# Safe");
    const edited = await library.update(note.id, { body: "# Safe\nsaved", expectedVersion: note.version }, author);
    expect((await library.read(edited.id)).body).toBe("# Safe\nsaved");
    expect(failures).toHaveLength(1);
});
