import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExternalLink, readSessionContext, resolveNotesDirectory, trashItem } from "../platform.mjs";

let fixture;
beforeEach(async () => { fixture = await mkdtemp(join(tmpdir(), "copilot-notes-platform-")); });
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

describe("platform integration", () => {
    test.each(["win32", "darwin", "linux"])("safe %s link opening never interpolates URL text into a shell command", async platform => {
        const url = "https://example.com/a?text='$(calc)'&next=1";
        const calls = [];
        await openExternalLink(url, { platform, run: async (command, args, options) => { calls.push({ command, args, options }); } });
        expect(calls).toHaveLength(1);
        expect(calls[0].options.shell).toBeUndefined();
        if (platform === "win32") {
            expect(calls[0].args.at(-1)).not.toContain("$(calc)");
            expect(calls[0].args.at(-1)).toContain(Buffer.from(url).toString("base64"));
        } else expect(calls[0].args.at(-1)).toBe(url);
        for (const unsafe of ["file:///tmp/x", "javascript:alert(1)", "data:text/html,bad", "//host", "https://x\nbad"]) {
            await expect(openExternalLink(unsafe, { platform, run: async () => { throw new Error("Must not run"); } })).rejects.toBeDefined();
        }
    });
    test("resolves redirected Windows Documents without guessing the home-directory path", async () => {
        const result = await resolveNotesDirectory({ platform: "win32", run: async (command, args) => {
            expect(command).toMatch(/powershell\.exe$/i);
            expect(args.join(" ")).toContain("GetFolderPath('MyDocuments'");
            return { stdout: "\ufeffD:\\OneDrive\\Documents\r\n" };
        } });
        expect(result).toBe("D:\\OneDrive\\Documents\\Copilot Notes");
    });

    test("uses platform Documents locations and refuses failed discovery", async () => {
        expect(await resolveNotesDirectory({ platform: "darwin", home: "/Users/example" }))
            .toBe("/Users/example/Documents/Copilot Notes");
        expect(await resolveNotesDirectory({ platform: "linux", run: async (command, args) => {
            expect(command).toBe("xdg-user-dir");
            expect(args).toEqual(["DOCUMENTS"]);
            return { stdout: "/home/example/Dokumenty\n" };
        } })).toBe("/home/example/Dokumenty/Copilot Notes");
        await expect(resolveNotesDirectory({ platform: "linux", run: async () => { throw new Error("Missing xdg-user-dir"); } }))
            .rejects.toMatchObject({ code: "documents_unavailable" });
        await expect(resolveNotesDirectory({ platform: "win32", run: async () => ({ stdout: "" }) }))
            .rejects.toMatchObject({ code: "documents_unavailable" });
    });

    test.each(["win32", "darwin", "linux"])("passes filenames as data to the %s trash adapter", async platform => {
        const path = join(fixture, "quoted '& $(name).md");
        const calls = [];
        await trashItem(path, { platform, run: async (command, args, options) => {
            calls.push({ command, args, options });
            return { stdout: "" };
        } });
        expect(calls).toHaveLength(1);
        const { command, args, options } = calls[0];
        expect(options.shell).toBeUndefined();
        if (platform === "win32") {
            expect(command).toMatch(/powershell\.exe$/i);
            expect(args).toContain("-STA");
            expect(Buffer.from(args.at(-1), "base64").toString("utf8")).toBe(path);
            expect(args.join(" ")).not.toContain("$(name)");
        } else {
            expect(args.at(-1)).toBe(path);
            expect(args.at(-2)).toBe("--");
            expect(command).toBe(platform === "darwin" ? "/usr/bin/osascript" : "gio");
        }
    });

    test("surfaces OS trash errors without attempting permanent deletion", async () => {
        const path = join(fixture, "keep.md");
        await writeFile(path, "keep");
        await expect(trashItem(path, { platform: "linux", run: async () => { throw new Error("gio failed"); } }))
            .rejects.toMatchObject({ code: "trash_unavailable" });
        expect((await lstat(path)).isFile()).toBe(true);
    });

    test.skipIf(process.platform !== "win32")("Windows recycle helper compiles and rejects a nonexistent item without trashing anything", async () => {
        let failure;
        try {
            await trashItem(join(fixture, "does-not-exist.md"));
        } catch (error) {
            failure = error;
        }
        expect(failure?.code).toBe("trash_unavailable");
        expect(failure.cause.stderr).toContain("0x80070002");
    }, 35000);

    test("reads only the requested session's metadata under the supplied Copilot home", async () => {
        const directory = join(fixture, "session-state", "session-a");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "workspace.yaml"),
            "id: session-a\nname: Writing notes\nrepository: owner/repo\nbranch: topic\ncwd: 'D:\\workspace'\n");
        expect(await readSessionContext("session-a", { home: fixture })).toEqual({
            sessionId: "session-a", sessionName: "Writing notes", project: "owner/repo", branch: "topic",
        });
        await writeFile(join(directory, "workspace.yaml"), "id: session-a\ncwd: '/work/local-folder'\n");
        expect(await readSessionContext("session-a", { home: fixture }))
            .toEqual({ sessionId: "session-a", project: "/work/local-folder" });
        await expect(readSessionContext("../elsewhere", { home: fixture })).rejects.toMatchObject({ code: "invalid_session" });
        await expect(readSessionContext("missing", { home: fixture })).rejects.toMatchObject({ code: "session_metadata_unavailable" });
    });

    test("refuses metadata for a different session and malformed workspace YAML", async () => {
        const directory = join(fixture, "session-state", "session-a");
        await mkdir(directory, { recursive: true });
        for (const raw of ["id: wrong-session\n", "name: [broken", "name: [array]\n"]) {
            await writeFile(join(directory, "workspace.yaml"), raw);
            await expect(readSessionContext("session-a", { home: fixture }))
                .rejects.toMatchObject({ code: "session_metadata_unavailable" });
        }
    });

    test("allowMissing treats absent session metadata as no session, but never unreadable or untrusted metadata", async () => {
        const options = { home: fixture, allowMissing: true };
        expect(await readSessionContext("app-control-session", options)).toEqual({});
        for (const id of [undefined, "", "../elsewhere"]) expect(await readSessionContext(id, options)).toEqual({});

        const directory = join(fixture, "session-state", "session-a");
        const file = join(directory, "workspace.yaml");
        await mkdir(directory, { recursive: true });
        await writeFile(file, "id: session-a\nname: Present\n");
        expect(await readSessionContext("session-a", options)).toEqual({ sessionId: "session-a", sessionName: "Present" });
        for (const raw of ["id: wrong-session\n", "name: [broken"]) {
            await writeFile(file, raw);
            await expect(readSessionContext("session-a", options)).rejects.toMatchObject({ code: "session_metadata_unavailable" });
        }
        await rm(file);
        await mkdir(file);
        await expect(readSessionContext("session-a", options)).rejects.toMatchObject({ code: "session_metadata_unavailable" });
    });

    test.skipIf(process.env.NOTES_TEST_REAL_TRASH !== "1")("opt-in real OS trash test (one temporary note)", async () => {
        const path = join(fixture, "copilot-notes-trash-smoke.md");
        await writeFile(path, "Temporary Notes adapter verification file.");
        await trashItem(path);
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }, 35000);
});
