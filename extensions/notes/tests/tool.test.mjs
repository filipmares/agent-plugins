import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NotesError } from "../errors.mjs";
import { createNotesTool } from "../notes-tool.mjs";
import { NotesLibrary } from "../storage.mjs";

let fixture, library, tool, calls, confirmations, logs;

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-tool-"));
    library = new NotesLibrary(join(fixture, "notes"), { trash: async path => {
        await mkdir(join(fixture, "trash"), { recursive: true });
        await rename(path, join(fixture, "trash", basename(path)));
    } });
    calls = [];
    confirmations = [];
    logs = [];
    tool = createNotesTool({
        getLibrary: async () => { calls.push("library"); return library; },
        getContext: async sessionId => { calls.push(sessionId); return { sessionId, sessionName: "Tool session", project: "owner/repo", branch: "topic" }; },
        confirmPermanent: async message => { confirmations.push(message); return false; },
        log: async message => { logs.push(message); },
    });
});

afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

async function call(args, sessionId = "session-a") {
    const result = await tool.handler(args, { sessionId, toolCallId: "test-call", toolName: "notes_manage" });
    return { ...result, data: JSON.parse(result.textResultForLlm) };
}

describe("notes_manage", () => {
    test("is lazy, stamps the real caller, and supports all eight operations without opening a panel", async () => {
        expect(calls).toEqual([]);
        const created = await call({ operation: "create", body: "# Via tool\nFirst", folder: "Inbox" });
        expect(created.resultType).toBe("success");
        let note = created.data;
        expect(note.frontmatter).toMatchObject({ created_by: "agent", session_id: "session-a", project: "owner/repo" });
        const search = await call({ operation: "search", query: "via", folder: "Inbox" });
        expect(search.data.total).toBe(1);
        const read = await call({ operation: "read", noteId: note.path });
        expect(read.data.id).toBe(note.id);
        note = (await call({ operation: "append", noteId: note.id, text: "Second", expectedVersion: note.version }, "session-b")).data;
        expect(note.frontmatter.sessions).toEqual(["session-a", "session-b"]);
        note = (await call({ operation: "update", noteId: note.id, find: "Second", replace: "Revised", expectedVersion: note.version })).data;
        expect(note.body).toContain("Revised");
        const folders = await call({ operation: "folders" });
        expect(folders.data.folders.children[0]).toMatchObject({ name: "Inbox", count: 1 });
        note = (await call({ operation: "move", noteId: note.id, folder: "", expectedVersion: note.version })).data;
        expect(note.folder).toBe("");
        const deleted = await call({ operation: "delete", noteId: note.id, expectedVersion: note.version });
        expect(deleted.data.method).toBe("trash");
        expect(confirmations).toEqual([]);
        expect(logs).toEqual([]);
    });

    test.each([
        null,
        { operation: "rename_folder", folder: "Inbox" },
        { operation: "delete_folder", folder: "" },
        { operation: "create", body: "# Forged", session_id: "another-session" },
        { operation: "delete", noteId: "a.md", expectedVersion: "a".repeat(64), permanent: true },
        { operation: "delete", noteId: "a.md" },
        { operation: "update", noteId: "a.md", body: "", find: "x", replace: "y", expectedVersion: "a".repeat(64) },
        { operation: "search", limit: 0 },
        { operation: "search", offset: -1 },
        { operation: "search", session: 10 },
        { operation: "folders", query: "" },
    ])("rejects malformed or out-of-scope requests before using the library", async args => {
        const result = await call(args);
        expect(result.resultType).toBe("failure");
        expect(result.data.error.code).toBe("invalid_request");
        expect(calls).toEqual([]);
        expect(logs).toHaveLength(1);
    });

    test("reports stale writes as structured failures instead of apparent success", async () => {
        const created = await call({ operation: "create", body: "# Stale" });
        const note = created.data;
        await call({ operation: "append", noteId: note.id, text: "Newer", expectedVersion: note.version });
        const failed = await call({ operation: "update", noteId: note.id, body: "# Old", expectedVersion: note.version });
        expect(failed.resultType).toBe("failure");
        expect(failed.data.error.code).toBe("conflict");
        expect((await library.read(note.id)).body).toContain("Newer");
    });

    test("requires a real confirmation on trash failure regardless of agent permission mode", async () => {
        library = new NotesLibrary(join(fixture, "notes"), { trash: async () => {
            throw new NotesError("trash_unavailable", "No trash");
        } });
        const note = (await call({ operation: "create", body: "# Keep" })).data;
        const result = await tool.handler({ operation: "delete", noteId: note.id, expectedVersion: note.version },
            { sessionId: "session-a", toolCallId: "delete", mode: "autopilot" });
        expect(result.resultType).toBe("failure");
        expect(JSON.parse(result.textResultForLlm).error.code).toBe("trash_unavailable");
        expect(confirmations).toHaveLength(1);
        expect((await library.read(note.id)).version).toBe(note.version);
    });

    test("does not invent provenance when metadata resolution fails", async () => {
        const unavailable = createNotesTool({
            getLibrary: async () => library,
            getContext: async () => { throw new NotesError("session_metadata_unavailable", "Cannot read workspace.yaml"); },
        });
        const result = await unavailable.handler({ operation: "create", body: "# Unstamped" }, { sessionId: "session-a" });
        expect(result.resultType).toBe("failure");
        expect(JSON.parse(result.textResultForLlm).error.code).toBe("session_metadata_unavailable");
        expect((await library.search()).total).toBe(0);
    });
});
