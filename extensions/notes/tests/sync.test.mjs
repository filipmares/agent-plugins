import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NotesLibrary } from "../storage.mjs";

let fixture, library;
const context = { sessionId: "sync-test", actor: "user" };
const waitFor = async predicate => {
    const deadline = Date.now() + 4000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw new Error("Live sync did not refresh the index.");
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "notes-sync-"));
    library = new NotesLibrary(fixture);
});
afterEach(async () => { library.close(); await rm(fixture, { recursive: true, force: true }); });

test("recursive watcher refreshes nested notes, moves, search, and folders without own-write churn", async () => {
    let changes = 0;
    await library.startWatching(() => changes++, { debounceMs: 15 });
    const note = await library.create({ body: "# Original\nneedle", folder: "Nested/Deep" }, context);
    expect(changes).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(changes).toBe(1);
    await writeFile(join(fixture, "Nested", "Deep", "added.md"), "# External\nfreshness");
    await waitFor(async () => (await library.search({ query: "freshness" })).total === 1);
    await rename(join(fixture, "Nested", "Deep", "added.md"), join(fixture, "Nested", "moved.md"));
    await waitFor(async () => (await library.search({ query: "freshness" })).notes[0]?.path === "Nested/moved.md");
    expect((await library.folders()).folders.children[0].count).toBe(1);
    await writeFile(join(fixture, ...note.path.split("/")), "# Replaced\nnew text");
    await waitFor(async () => (await library.search({ query: "needle" })).total === 0);
});

test("unsupported recursive watch falls back, reports the limitation, and closes cleanly", async () => {
    const warnings = [];
    let changes = 0;
    await library.startWatching(() => changes++, {
        watchFs() { throw new Error("recursive watch unsupported"); },
        intervalMs: 25,
        log: message => warnings.push(message),
    });
    expect(warnings[0]).toContain("periodic rescan");
    await mkdir(join(fixture, "Folder"));
    await writeFile(join(fixture, "Folder", "new.md"), "# Fallback");
    await waitFor(async () => (await library.search({ query: "Fallback" })).total === 1);
    const before = changes;
    library.close();
    await writeFile(join(fixture, "Folder", "new.md"), "# Closed");
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(changes).toBe(before);
});
