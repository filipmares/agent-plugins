import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { FailureJournal } from "../failure-journal.mjs";
import { retryTransient } from "../filesystem.mjs";
import { ULID } from "../note-format.mjs";
import { ShadowIndex, shadowIndexFile } from "../shadow-index.mjs";
import { NotesLibrary } from "../storage.mjs";

const execute = promisify(execFile);
const author = { sessionId: "session-a", actor: "agent" };
let fixture, root, indexDirectory, library, failures, logs;

const trash = async path => {
    await mkdir(join(fixture, "trash"), { recursive: true });
    await retryTransient(() => rename(path, join(fixture, "trash", basename(path))));
};
const indexed = (options = {}) => new NotesLibrary(root, {
    trash,
    index: new ShadowIndex({
        directory: indexDirectory,
        log: (message, details) => logs.push({ message, ...details }),
        onFailure: (error, code) => failures.push(code),
        ...options,
    }),
});
const indexPath = async () => join(indexDirectory, shadowIndexFile(await realpath(root)));

async function write(path, content) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
}

async function withIndex(read) {
    const db = new DatabaseSync(await indexPath());
    try { return read(db); } finally { db.close(); }
}

const contents = () => withIndex(db => ({
    signature: db.prepare("SELECT value FROM meta WHERE key = 'signature'").get()?.value,
    notes: db.prepare("SELECT * FROM notes ORDER BY path").all().map(row => ({
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
    library.close();
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

test("follows edits, moves, external changes and deletions, and skips unchanged scans", async () => {
    const first = await library.create({ body: "# First" }, author);
    const second = await library.create({ body: "# Second" }, author);
    const third = await library.create({ body: "# Third" }, author);
    await library.search();
    const reader = new DatabaseSync(await indexPath());
    try {
        const dataVersion = () => reader.prepare("PRAGMA data_version").get().data_version;
        const before = dataVersion();
        await library.search();
        await library.read(first.id);
        expect(dataVersion()).toBe(before);

        await library.update(first.id, { body: "# First\nedited", expectedVersion: first.version }, author);
        await mkdir(join(root, "Archive"));
        await library.move(second.id, { folder: "Archive", expectedVersion: second.version });
        await library.delete(third.id, { expectedVersion: third.version });
        await write("external.md", "---\nid: 01J0000000000000000000000A\n---\n# External");
        await library.search();
        expect(dataVersion()).not.toBe(before);
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
    library.close();

    const reader = new DatabaseSync(await indexPath());
    try {
        const before = reader.prepare("PRAGMA data_version").get().data_version;
        library = indexed();
        await library.search();
        expect(reader.prepare("PRAGMA data_version").get().data_version).toBe(before);
    } finally { reader.close(); }
    library.close();

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
        library.close();
        process.stdout.write(JSON.stringify(failures));`;
    const outputs = await Promise.all(["alpha", "beta", "gamma"].map(async name =>
        (await execute(process.execPath, ["-e", script, root, indexDirectory, name])).stdout));
    expect(outputs).toEqual(["[]", "[]", "[]"]);
    const actual = await contents();
    expect(actual.notes).toEqual((await production()).notes);
    expect(actual.notes.map(row => row.path)).toEqual(["alpha.md", "beta.md", "gamma.md"]);
}, 15000);

test("unavailable SQLite is reported once and Notes keeps working, even if logging throws", async () => {
    library.close();
    library = indexed({
        log: () => { throw new Error("session closed"); },
        loadSqlite: async () => { throw Object.assign(new Error("No such built-in module"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" }); },
    });
    await library.create({ body: "# Works" }, author);
    expect((await library.search()).notes.map(note => note.path)).toEqual(["works.md"]);
    expect(failures).toEqual(["index_unavailable"]);
    await expect(lstat(indexDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an index directory inside the Notes library is refused before anything is written there", async () => {
    library.close();
    const inside = join(await realpath(root), "copilot-home", "index");
    library = indexed({ directory: inside });
    await library.create({ body: "# Works" }, author);
    expect((await library.search()).notes.map(note => note.path)).toEqual(["works.md"]);
    expect(failures).toEqual(["index_unavailable"]);
    await expect(lstat(join(root, "copilot-home"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform === "win32")("an existing index directory is made owner-only", async () => {
    library.close();
    await mkdir(indexDirectory, { recursive: true });
    await chmod(indexDirectory, 0o755);
    library = indexed();
    await library.search();
    expect((await lstat(indexDirectory)).mode & 0o777).toBe(0o700);
    expect(failures).toEqual([]);
});

test("closing while the index opens leaves no connection or write behind", async () => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    const index = new ShadowIndex({ directory: indexDirectory, loadSqlite: async () => { await gate; return import("node:sqlite"); } });
    const updating = index.update(await realpath(root), { notes: [], folders: [""], warnings: [] }, "signature");
    index.close();
    release();
    await updating;
    expect((await withIndex(db => db.prepare("SELECT value FROM meta").all())).length).toBe(0);
    await rm(indexDirectory, { recursive: true });
    await index.update(await realpath(root), { notes: [], folders: [""], warnings: [] }, "signature");
    await expect(lstat(indexDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a corrupt index is journaled and left untouched while Notes keeps working", async () => {
    const journal = new FailureJournal({ path: join(fixture, "journal.jsonl") });
    let recorded;
    library.close();
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

test("a busy index is skipped without failing or delaying past its timeout, even if logging rejects", async () => {
    library.close();
    library = indexed({ log: (message, details) => { logs.push({ message, ...details }); return Promise.reject(new Error("session closed")); } });
    await library.create({ body: "# Before" }, author);
    await library.search();
    const blocker = new DatabaseSync(await indexPath());
    try {
        blocker.exec("BEGIN IMMEDIATE");
        await write("after.md", "---\nid: 01J0000000000000000000000B\n---\n# After");
        const started = performance.now();
        expect((await library.search()).total).toBe(2);
        expect(performance.now() - started).toBeLessThan(5000);
        expect(failures).toEqual(["index_busy"]);
        expect(logs).toEqual([expect.objectContaining({ level: "warning" })]);
        blocker.exec("ROLLBACK");
    } finally { blocker.close(); }
    await library.search();
    expect(failures).toEqual(["index_busy"]);
    expect((await contents()).notes.map(row => row.path)).toEqual(["before.md"]);
});
