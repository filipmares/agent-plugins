import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { NotesError } from "../errors.mjs";
import { MAX_NOTE_BYTES, withLibraryLock, writeNoteFile } from "../filesystem.mjs";
import { ULID } from "../note-format.mjs";
import { NotesLibrary } from "../storage.mjs";

const execute = promisify(execFile);
const author = { sessionId: "session-a", sessionName: "Planning", project: "owner/repo", branch: "work", actor: "agent" };
let fixture, root, library;

async function write(path, content) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
    return target;
}

async function recycle(path) {
    const destination = join(fixture, "trash", basename(path));
    await mkdir(join(fixture, "trash"), { recursive: true });
    await rename(path, destination);
}

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-test-"));
    root = join(fixture, "notes");
    await mkdir(root);
    library = new NotesLibrary(root, { trash: recycle });
});

afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
});

describe("notes and provenance", () => {
    test("creates a titled note and keeps its origin while later sessions edit it", async () => {
        const note = await library.create({ body: "Caf\u00e9 plan\nFirst line" }, author);
        expect(note.path).toBe("cafe-plan.md");
        expect(note.body).toBe("# Caf\u00e9 plan\nFirst line");
        expect(note.id).toMatch(ULID);
        expect(note.frontmatter).toMatchObject({
            created_by: "agent", session_id: "session-a", session_name: "Planning",
            project: "owner/repo", branch: "work", sessions: ["session-a"],
        });
        const edited = await library.append(note.id, { text: "Second line", expectedVersion: note.version },
            { ...author, sessionId: "session-b", sessionName: "Different", project: "another/repo", actor: "user" });
        expect(edited.body).toBe("# Caf\u00e9 plan\nFirst line\nSecond line");
        expect(edited.frontmatter).toMatchObject({
            created_by: "agent", session_id: "session-a", session_name: "Planning",
            project: "owner/repo", branch: "work", sessions: ["session-a", "session-b"],
        });
        expect(edited.id).toBe(note.id);
        expect((await library.search({ session: "session-b" })).notes.map(item => item.id)).toEqual([note.id]);
        expect((await library.search({ project: "another/repo" })).total).toBe(0);
    });

    test("refuses empty new notes, but clearing an existing note keeps its identity", async () => {
        await expect(library.create({ body: " \n" }, author)).rejects.toMatchObject({ code: "invalid_request" });
        expect(await readdir(root)).toEqual([]);
        const note = await library.create({ body: "# Erase me\nContent" }, author);
        const empty = await library.update(note.id, { body: "", expectedVersion: note.version }, author);
        expect(empty.id).toBe(note.id);
        expect(empty.body).toBe("");
        expect((await library.read(empty.id)).body).toBe("");
    });

    test("viewing and no-op updates leave managed files byte-for-byte unchanged", async () => {
        const note = await library.create({ body: "# Quiet\n* original" }, author);
        const before = await readFile(join(root, note.path));
        const stat = await lstat(join(root, note.path));
        const opened = await library.read(note.id);
        const result = await library.update(note.id, { body: opened.body, expectedVersion: opened.version },
            { ...author, sessionId: "ignored-no-op" });
        expect(result.version).toBe(opened.version);
        expect(await readFile(join(root, note.path))).toEqual(before);
        expect((await lstat(join(root, note.path))).mtimeMs).toBe(stat.mtimeMs);
        expect(result.frontmatter.sessions).toEqual(["session-a"]);
    });

    test("find/replace is literal, refuses missing or ambiguous matches, and can replace all explicitly", async () => {
        const note = await library.create({ body: "# Matches\n$1 [x] [x]" }, author);
        await expect(library.update(note.id, { find: "absent", replace: "", expectedVersion: note.version }, author))
            .rejects.toMatchObject({ code: "match_not_found" });
        await expect(library.update(note.id, { find: "[x]", replace: "done", expectedVersion: note.version }, author))
            .rejects.toMatchObject({ code: "ambiguous_match" });
        const result = await library.update(note.id, {
            find: "[x]", replace: "$&", replaceAll: true, expectedVersion: note.version,
        }, author);
        expect(result.body).toBe("# Matches\n$1 $& $&");
    });

    test("checks content versions even when an external editor preserves mtime", async () => {
        const note = await library.create({ body: "# Shared\nOld" }, author);
        const path = join(root, note.path);
        const stats = await lstat(path);
        const changed = (await readFile(path, "utf8")).replace("Old", "External edit");
        await writeFile(path, changed);
        await utimes(path, stats.atime, stats.mtime);
        await expect(library.update(note.id, { body: "# Shared\nOverwrite", expectedVersion: note.version }, author))
            .rejects.toMatchObject({ code: "conflict" });
        expect(await readFile(path, "utf8")).toBe(changed);
    });

    test("pinning changes neither edit date nor editing sessions", async () => {
        const note = await library.create({ body: "# Pinned" }, author);
        const originalTime = (await lstat(join(root, note.path))).mtimeMs;
        const pinned = await library.pin(note.id, true, note.version);
        expect(pinned.pinned).toBe(true);
        expect(pinned.frontmatter.updated).toBe(note.frontmatter.updated);
        expect(pinned.frontmatter.sessions).toEqual(note.frontmatter.sessions);
        expect(Math.abs((await lstat(join(root, note.path))).mtimeMs - originalTime)).toBeLessThan(1);
        const unpinned = await library.pin(note.id, false, pinned.version);
        expect(unpinned.frontmatter).not.toHaveProperty("pinned");
        expect(unpinned.frontmatter.updated).toBe(note.frontmatter.updated);
    });
});

describe("adoption", () => {
    test("unsupported YAML collections and adoption-size failures do not block healthy notes", async () => {
        const healthy = await library.create({ body: "# Healthy" }, author);
        const incompatible = "---\n!!set {a, b}\n---\n# Set";
        await write("set.md", incompatible);
        const huge = Buffer.alloc(MAX_NOTE_BYTES, 120);
        await write("borderline.md", huge);
        expect((await library.read(healthy.id)).body).toBe("# Healthy");
        const found = await library.search();
        expect(found.warnings).toContainEqual(expect.objectContaining({ path: "set.md", code: "invalid_frontmatter" }));
        expect(found.warnings).toContainEqual(expect.objectContaining({ path: "borderline.md", code: "note_too_large" }));
        expect((await library.read("set.md")).body).toBe(incompatible);
        expect(await readFile(join(root, "borderline.md"))).toEqual(huge);
    });

    test("appending preserves valid aliases to the editing-session sequence", async () => {
        await write("aliased.md", "---\nsessions: &s [session-a]\ncustom: *s\n---\n# Aliased");
        const note = await library.read("aliased.md");
        const edited = await library.append(note.id, { text: "More", expectedVersion: note.version }, { ...author, sessionId: "session-b" });
        expect(edited.warning).toBeUndefined();
        expect(edited.frontmatter.custom).toEqual(["session-a", "session-b"]);
        expect(edited.body).toBe("# Aliased\nMore");
    });

    test("preserves Markdown bytes, custom YAML values/comments and old mtime without inventing origin", async () => {
        const body = "# Imported\r\n\r\n*  Keep this spacing\r\n";
        const raw = "\ufeff---\r\n# My comment\r\ncolor: 'blue' # Inline\r\nnested: {keep: yes}\r\n---\r\n" + body;
        const path = await write("Imported.md", raw);
        const old = new Date("2005-04-03T02:01:00Z");
        await utimes(path, old, old);
        const note = await library.read("Imported.md");
        expect(note.body).toBe(body);
        expect(note.id).toMatch(ULID);
        expect(note.frontmatter).toMatchObject({ color: "blue", nested: { keep: "yes" }, sessions: [] });
        for (const field of ["project", "branch", "session_id", "session_name", "created_by"]) {
            expect(note.frontmatter).not.toHaveProperty(field);
        }
        const adopted = await readFile(path, "utf8");
        expect(adopted).toContain("# My comment\r\n");
        expect(adopted).toContain("# Inline\r\n");
        expect(adopted.startsWith("\ufeff")).toBe(true);
        expect((await lstat(path)).mtimeMs).toBe(old.getTime());
        expect(new Date(note.frontmatter.updated).getTime()).toBe(old.getTime());
        const edited = await library.append(note.id, { text: "Edited", expectedVersion: note.version }, author);
        expect(edited.path).toBe("Imported.md");
        expect(edited.frontmatter.sessions).toEqual(["session-a"]);
        expect(edited.frontmatter).not.toHaveProperty("project");
    });

    test("malformed YAML remains untouched, visible and editable only as raw Markdown", async () => {
        const raw = "---\ncolor: [broken\n---\n# Broken\n";
        await write("broken.md", raw);
        const search = await library.search();
        expect(search.warnings).toContainEqual(expect.objectContaining({ path: "broken.md", code: "invalid_frontmatter" }));
        const note = await library.read("broken.md");
        expect(note.id).toBe(null);
        expect(note.body).toBe(raw);
        expect(await readFile(join(root, "broken.md"), "utf8")).toBe(raw);
        const repaired = await library.update("broken.md", { body: raw.replace("[broken", "fixed"), expectedVersion: note.version }, author);
        const adopted = await library.read("broken.md");
        expect(repaired.warning).toBeUndefined();
        expect(adopted.id).toMatch(ULID);
        expect(adopted.frontmatter.sessions).toContain("session-a");
    });

    test("a copied file gets a new ID while the older file retains its ID", async () => {
        const original = await library.create({ body: "# Original" }, author);
        await delay(20);
        await copyFile(join(root, original.path), join(root, "copy.md"));
        const found = await library.search();
        expect(new Set(found.notes.map(note => note.id)).size).toBe(2);
        expect((await library.read("original.md")).id).toBe(original.id);
        expect((await library.read("copy.md")).id).not.toBe(original.id);
    });

    test("concurrent processes adopt the same file consistently", async () => {
        await write("shared.md", "# Shared\nOriginal bytes");
        const old = new Date("2011-02-03T04:05:06Z");
        await utimes(join(root, "shared.md"), old, old);
        const script = `import { NotesLibrary } from ${JSON.stringify(new URL("../storage.mjs", import.meta.url).href)};
            const note = await new NotesLibrary(process.argv[1]).read("shared.md");
            process.stdout.write(JSON.stringify({id: note.id, version: note.version}));`;
        const results = await Promise.all(Array.from({ length: 3 }, async () => {
            const { stdout } = await execute("node", ["--input-type=module", "-e", script, root]);
            return JSON.parse(stdout);
        }));
        expect(new Set(results.map(note => note.id)).size).toBe(1);
        expect(new Set(results.map(note => note.version)).size).toBe(1);
        expect((await lstat(join(root, "shared.md"))).mtimeMs).toBe(old.getTime());
        expect(await readdir(root)).toEqual(["shared.md"]);
    }, 15000);

    test("concurrent processes cannot both save against the same version", async () => {
        const note = await library.create({ body: "# Shared\nInitial" }, author);
        const script = `import { NotesLibrary } from ${JSON.stringify(new URL("../storage.mjs", import.meta.url).href)};
            try {
                await new NotesLibrary(process.argv[1]).update(process.argv[2],
                    {body: "# Shared\\n" + process.argv[4], expectedVersion: process.argv[3]},
                    {sessionId: process.argv[4], actor: "agent"});
                process.stdout.write("saved");
            } catch (error) { process.stdout.write(error.code); }`;
        const outcomes = await Promise.all(["first", "second"].map(async name => {
            const { stdout } = await execute("node", ["--input-type=module", "-e", script, root, note.id, note.version, name]);
            return stdout;
        }));
        expect(outcomes.sort()).toEqual(["conflict", "saved"]);
        const saved = await library.read(note.id);
        expect(saved.frontmatter.sessions).toHaveLength(2);
        expect(["# Shared\nfirst", "# Shared\nsecond"]).toContain(saved.body);
    }, 15000);
});

describe("names, folders, and assets", () => {
    test.each(["Plan", "a".repeat(40)])("moving colliding generated names retains title tracking: %s", async title => {
        await library.create({ body: title }, author);
        const note = await library.create({ body: title }, author);
        await library.create({ body: title, folder: "Work" }, author);
        await library.create({ body: title, folder: "Work" }, author);
        const moved = await library.move(note.id, { folder: "Work", expectedVersion: note.version });
        expect(basename(moved.path).slice(0, -3).length).toBeLessThanOrEqual(40);
        expect(moved.path).toEndWith("-3.md");
        const edited = await library.update(note.id, { body: "# Retitled", expectedVersion: moved.version }, author);
        expect(edited.path).toBe("Work/retitled.md");
    });

    test.skipIf(process.platform !== "win32")("retitling follows actual case-insensitive asset links on Windows", async () => {
        const note = await library.create({ body: "# Old\n![pic](OLD.assets/p.png)" }, author);
        await write("old.assets/p.png", "pixels");
        const edited = await library.update(note.id, { body: "# New\n![pic](OLD.assets/p.png)", expectedVersion: note.version }, author);
        expect(edited.body).toContain("![pic](new.assets/p.png)");
        expect(await readFile(join(root, "new.assets", "p.png"), "utf8")).toBe("pixels");
    });

    test("uses collision suffixes, including a 40-character title, and still auto-renames", async () => {
        const title = "a".repeat(40);
        const first = await library.create({ body: title }, author);
        const second = await library.create({ body: title }, author);
        expect(first.path).toBe(`${title}.md`);
        expect(second.path).toBe(`${"a".repeat(38)}-2.md`);
        const renamed = await library.update(second.id, { body: "# Different", expectedVersion: second.version }, author);
        expect(renamed.path).toBe("different.md");
        expect(renamed.id).toBe(second.id);
    });

    test("renames a title and its assets, but leaves code examples intact", async () => {
        const body = "# Old\n![pic](old.assets/a.png)\n[download][asset]\n\n[asset]: old.assets/a.png\n\n`old.assets/a.png`";
        const note = await library.create({ body }, author);
        await write("old.assets/a.png", "image-bytes");
        const edited = await library.update(note.id, { body: body.replace("# Old", "# New"), expectedVersion: note.version }, author);
        expect(edited.path).toBe("new.md");
        expect(edited.body).toContain("![pic](new.assets/a.png)");
        expect(edited.body).toContain("[asset]: new.assets/a.png");
        expect(edited.body).toContain("`old.assets/a.png`");
        expect(await readFile(join(root, "new.assets", "a.png"), "utf8")).toBe("image-bytes");
        await expect(lstat(join(root, "old.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("an external filename is retained when the title changes", async () => {
        const note = await library.create({ body: "# Original" }, author);
        await rename(join(root, note.path), join(root, "Custom Filename.md"));
        const opened = await library.read(note.id);
        const edited = await library.update(note.id, { body: "# Renamed title", expectedVersion: opened.version }, author);
        expect(edited.path).toBe("Custom Filename.md");
    });

    test("creates readable nested folders, resolves case, and counts only direct notes", async () => {
        const note = await library.create({ body: "# Nested", folder: "Work: Projects/Meetings" }, author);
        expect(note.folder).toBe("Work Projects/Meetings");
        await library.create({ body: "# Parent", folder: "work projects" }, author);
        const tree = (await library.folders()).folders;
        expect(tree.count).toBe(0);
        expect(tree.children[0]).toMatchObject({ name: "Work Projects", count: 1 });
        expect(tree.children[0].children[0]).toMatchObject({ name: "Meetings", count: 1 });
        await expect(library.createFolder("WORK PROJECTS")).rejects.toMatchObject({ code: "already_exists" });
        await expect(library.createFolder("CON")).rejects.toMatchObject({ code: "invalid_name" });
        await expect(library.createFolder(".hidden")).rejects.toMatchObject({ code: "invalid_name" });
        expect((await library.search({ folder: "Work Projects" })).total).toBe(2);
    });

    test("moves a note with collision-safe assets and keeps its dates and provenance", async () => {
        const note = await library.create({ body: "# Plan\n![pic](plan.assets/p.png)" }, author);
        await write("plan.assets/p.png", "pixels");
        await library.create({ body: "# Plan", folder: "Work" }, author);
        const moved = await library.move(note.id, { folder: "Work", expectedVersion: note.version });
        expect(moved.path).toBe("Work/plan-2.md");
        expect(moved.id).toBe(note.id);
        expect(moved.frontmatter).toEqual(note.frontmatter);
        expect(moved.body).toContain("plan-2.assets/p.png");
        expect(await readFile(join(root, "Work", "plan-2.assets", "p.png"), "utf8")).toBe("pixels");
        expect(new Date(moved.lastEdited).getTime()).toBe(new Date(note.lastEdited).getTime());
    });

    test.each([
        ["Report #1", "Report%20%231"],
        ["Foo (", "Foo%20%28"],
        ["Foo )", "Foo%20%29"],
    ])("moves imported asset links with encoded reserved characters: %s", async (name, encoded) => {
        await write(`${name}.md`, `# Report\n![image](${encoded}.assets/p.png)`);
        await write(`${name}.assets/p.png`, "pixels");
        await write(`Work/${name}.md`, "# Other");
        const note = await library.read(`${name}.md`);
        const moved = await library.move(note.id, { folder: "Work", expectedVersion: note.version });
        expect(moved.path).toBe(`Work/${name}-2.md`);
        expect(moved.body).toContain(`![image](${encoded}-2.assets/p.png)`);
        expect(await readFile(join(root, "Work", `${name}-2.assets`, "p.png"), "utf8")).toBe("pixels");
    });

    test("concurrent creators never overwrite a same-title note", async () => {
        const other = new NotesLibrary(root);
        const notes = await Promise.all([
            library.create({ body: "# Same\nOne" }, author),
            other.create({ body: "# Same\nTwo" }, author),
        ]);
        expect(new Set(notes.map(note => note.id)).size).toBe(2);
        expect(notes.map(note => note.path).sort()).toEqual(["same-2.md", "same.md"]);
        expect((await library.search({ query: "Same" })).total).toBe(2);
    });

    test("renames real folders and refuses renaming or deleting the library root", async () => {
        const note = await library.create({ body: "# Note", folder: "Before" }, author);
        const folder = (await library.folders()).folders.children[0];
        await library.renameFolder("Before", "After", folder.version);
        expect((await library.read(note.id)).path).toBe("After/note.md");
        await expect(library.renameFolder("", "Bad", folder.version)).rejects.toMatchObject({ code: "invalid_path" });
        await expect(library.deleteFolder("", { expectedVersion: folder.version })).rejects.toMatchObject({ code: "invalid_path" });
    });
});

describe("search and filesystem boundaries", () => {
    test("refuses a library-root junction before adoption and after initial use", async () => {
        const outside = join(fixture, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "private.md"), "# Outside");
        const redirected = join(fixture, "redirected");
        await symlink(outside, redirected, process.platform === "win32" ? "junction" : "dir");
        await expect(new NotesLibrary(redirected).search()).rejects.toMatchObject({ code: "unsafe_path" });
        await library.search();
        await rename(root, join(fixture, "original"));
        await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
        await expect(library.search()).rejects.toMatchObject({ code: "unsafe_path" });
        expect(await readFile(join(outside, "private.md"), "utf8")).toBe("# Outside");
        expect(await readdir(outside)).toEqual(["private.md"]);
    });

    test("ignored junctions warn without hiding folders or permitting folder mutation", async () => {
        await library.create({ body: "# Visible", folder: "Work" }, author);
        const outside = join(fixture, "outside");
        await mkdir(outside);
        await symlink(outside, join(root, "Work", ".ignored"), process.platform === "win32" ? "junction" : "dir");
        const tree = await library.folders();
        expect(tree.folders.children[0]).toMatchObject({ path: "Work", count: 1, version: null });
        expect(tree.warnings).toContainEqual(expect.objectContaining({ path: "Work", code: "unsafe_path" }));
        await expect(library.renameFolder("Work", "Renamed", "0".repeat(64))).rejects.toMatchObject({ code: "unsafe_path" });
        await expect(library.deleteFolder("Work", { expectedVersion: "0".repeat(64), confirmDelete: async () => true }))
            .rejects.toMatchObject({ code: "unsafe_path" });
    });

    test("search ignores accents/case and metadata, requires every word, and ranks titles before recency", async () => {
        const title = await library.create({ body: "# Caf\u00e9 budget\nEarlier" }, author);
        const body = await library.create({ body: "# Other\nCAF\u00c9 budget" }, author);
        const found = await library.search({ query: "cafe BUDGET", limit: 1 });
        expect(found.notes[0].id).toBe(title.id);
        expect(found.total).toBe(2);
        expect(found.nextOffset).toBe(1);
        expect((await library.search({ query: "cafe budget", offset: found.nextOffset })).notes[0].id).toBe(body.id);
        expect((await library.search({ query: "cafe absent" })).total).toBe(0);
        expect((await library.search({ query: "session-a" })).total).toBe(0);
    });

    test("uses external modified time for sorting and skips hidden, assets and non-Markdown files", async () => {
        const older = await library.create({ body: "# Older" }, author);
        const newer = await library.create({ body: "# Newer" }, author);
        await utimes(join(root, older.path), new Date(), new Date("2040-01-01T00:00:00Z"));
        await write(".private/secret.md", "do not adopt");
        await write("older.assets/asset.md", "not a note");
        await write("skip.txt", "not a note");
        const found = await library.search();
        expect(found.notes.map(item => item.id)).toEqual([older.id, newer.id]);
        expect(await readFile(join(root, ".private", "secret.md"), "utf8")).toBe("do not adopt");
        expect(await readFile(join(root, "older.assets", "asset.md"), "utf8")).toBe("not a note");
    });

    test("refuses traversal, symlinked folders, and hard-linked notes without touching outside data", async () => {
        const outside = join(fixture, "outside");
        await mkdir(outside);
        await writeFile(join(outside, "private.md"), "outside-data");
        await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
        await link(join(outside, "private.md"), join(root, "hardlink.md"));
        for (const folder of ["../outside", "escape", ".private"]) {
            await expect(library.create({ body: "# Unsafe", folder }, author)).rejects.toBeInstanceOf(NotesError);
        }
        await expect(library.read("../outside/private.md")).rejects.toMatchObject({ code: "invalid_path" });
        const found = await library.search();
        expect(found.total).toBe(0);
        expect(found.warnings.filter(item => item.code === "unsafe_path")).toHaveLength(2);
        expect(await readFile(join(outside, "private.md"), "utf8")).toBe("outside-data");
    });

    test("does not adopt invalid UTF-8 and surfaces a warning", async () => {
        await write("binary.md", Buffer.from([0xff, 0xfe, 0x80]));
        const found = await library.search();
        expect(found.total).toBe(0);
        expect(found.warnings).toContainEqual(expect.objectContaining({ code: "invalid_encoding", path: "binary.md" }));
        expect(await readFile(join(root, "binary.md"))).toEqual(Buffer.from([0xff, 0xfe, 0x80]));
    });

    test("an abandoned write lock fails closed rather than breaking another writer's lock", async () => {
        await write(".notes-write.lock", "other writer");
        await expect(withLibraryLock(root, () => { throw new Error("must not run"); }, { timeoutMs: 30 }))
            .rejects.toMatchObject({ code: "library_busy" });
        expect(await readFile(join(root, ".notes-write.lock"), "utf8")).toBe("other writer");
    });

    test("cleans temporary files after a failed final version check without altering the note", async () => {
        const note = await library.create({ body: "# Original" }, author);
        const original = await readFile(join(root, note.path), "utf8");
        await expect(withLibraryLock(root, () => writeNoteFile(root, note.path, "must not replace", "0".repeat(64))))
            .rejects.toMatchObject({ code: "conflict" });
        expect(await readdir(root)).toEqual([note.path]);
        expect(await readFile(join(root, note.path), "utf8")).toBe(original);
    });

    test("rejects oversized writes and reports oversized existing files without adopting them", async () => {
        await expect(library.create({ body: "# Huge\n" + "x".repeat(MAX_NOTE_BYTES) }, author))
            .rejects.toMatchObject({ code: "note_too_large" });
        expect(await readdir(root)).toEqual([]);
        await write("huge.md", Buffer.alloc(MAX_NOTE_BYTES + 1, 120));
        const result = await library.search();
        expect(result.total).toBe(0);
        expect(result.warnings).toContainEqual(expect.objectContaining({ code: "note_too_large" }));
        expect((await lstat(join(root, "huge.md"))).size).toBe(MAX_NOTE_BYTES + 1);
    });
});

describe("trash and explicit permanent-deletion confirmation", () => {
    test("trashes the note and its asset folder without asking for permanent deletion", async () => {
        const note = await library.create({ body: "# Remove" }, author);
        await write("remove.assets/file.txt", "assets");
        const result = await library.delete(note.id, {
            expectedVersion: note.version,
            confirmPermanent: () => { throw new Error("must not ask"); },
        });
        expect(result).toMatchObject({ deleted: ["remove.md", "remove.assets"], method: "trash" });
        expect(await readFile(join(fixture, "trash", "remove.assets", "file.txt"), "utf8")).toBe("assets");
    });

    test.each([false, undefined, "yes"])("never permanently deletes for a non-true confirmation: %s", async answer => {
        const broken = new NotesLibrary(root, { trash: async () => { throw new NotesError("trash_unavailable", "Unavailable"); } });
        const note = await broken.create({ body: "# Keep" }, author);
        await expect(broken.delete(note.id, { expectedVersion: note.version, confirmPermanent: async () => answer }))
            .rejects.toMatchObject({ code: "trash_unavailable" });
        expect((await broken.read(note.id)).version).toBe(note.version);
    });

    test("unsupported confirmation is a failure, even for an agent, and an explicit Yes allows permanent deletion", async () => {
        const broken = new NotesLibrary(root, { trash: async () => { throw new NotesError("trash_unavailable", "Unavailable"); } });
        const note = await broken.create({ body: "# Keep" }, author);
        await expect(broken.delete(note.id, {
            expectedVersion: note.version, confirmPermanent: async () => { throw new Error("Unsupported host"); },
        })).rejects.toMatchObject({ code: "trash_unavailable" });
        const result = await broken.delete(note.id, {
            expectedVersion: note.version,
            confirmPermanent: async message => {
                expect(message).toContain("Permanently delete");
                return true;
            },
        });
        expect(result.method).toBe("permanent");
        await expect(lstat(join(root, note.path))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("rechecks the content after confirmation rather than deleting an intervening external edit", async () => {
        const broken = new NotesLibrary(root, { trash: async () => { throw new NotesError("trash_unavailable", "Unavailable"); } });
        const note = await broken.create({ body: "# Keep" }, author);
        await expect(broken.delete(note.id, {
            expectedVersion: note.version,
            confirmPermanent: async () => {
                await writeFile(join(root, note.path), "# External edit");
                return true;
            },
        })).rejects.toMatchObject({ code: "conflict" });
        expect(await readFile(join(root, note.path), "utf8")).toBe("# External edit");
    });

    test("reports partial trash operations and leaves remaining assets when confirmation is declined", async () => {
        const partial = new NotesLibrary(root, { trash: async path => {
            if (path.endsWith(".assets")) throw new NotesError("trash_unavailable", "Unavailable");
            await recycle(path);
        } });
        const note = await partial.create({ body: "# Partial" }, author);
        await write("partial.assets/image.png", "pixels");
        await expect(partial.delete(note.id, { expectedVersion: note.version, confirmPermanent: async () => false }))
            .rejects.toMatchObject({ code: "trash_unavailable", details: { deleted: ["partial.md"], remaining: "partial.assets" } });
        expect(await readFile(join(root, "partial.assets", "image.png"), "utf8")).toBe("pixels");
    });

    test("reports partial trash state when later verification or filesystem operations fail", async () => {
        const partial = new NotesLibrary(root, { trash: async path => {
            await recycle(path);
            await write("partial.assets/new.png", "external edit");
        } });
        const note = await partial.create({ body: "# Partial" }, author);
        await write("partial.assets/image.png", "pixels");
        await expect(partial.delete(note.id, { expectedVersion: note.version })).rejects.toMatchObject({
            code: "conflict", details: { deleted: ["partial.md"], remaining: "partial.assets" },
        });
        const retry = await library.create({ body: "# Retry" }, author);
        await write("retry.assets/image.png", "pixels");
        const failing = new NotesLibrary(root, { trash: async path => {
            if (path.endsWith(".assets")) throw Object.assign(new Error("Access denied"), { code: "EACCES" });
            await recycle(path);
        } });
        await expect(failing.delete(retry.id, { expectedVersion: retry.version })).rejects.toMatchObject({
            code: "delete_incomplete", details: { deleted: ["retry.md"], remaining: "retry.assets" },
        });
    });

    test("folder deletion requires its own confirmation with a recursive note count", async () => {
        await library.create({ body: "# First", folder: "Work" }, author);
        await library.create({ body: "# Second", folder: "Work/Nested" }, author);
        const folder = (await library.folders()).folders.children[0];
        await expect(library.deleteFolder("Work", { expectedVersion: folder.version, confirmDelete: async () => false }))
            .rejects.toMatchObject({ code: "delete_cancelled" });
        const result = await library.deleteFolder("Work", {
            expectedVersion: folder.version,
            confirmDelete: async message => {
                expect(message).toContain("2 notes");
                return true;
            },
        });
        expect(result).toEqual({ deleted: ["Work"], method: "trash" });
        expect(await readFile(join(fixture, "trash", "Work", "Nested", "second.md"), "utf8")).toContain("# Second");
    });
});
