import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_JOURNAL_RETENTION_MS, MAX_BUNDLE_BYTES, MAX_JOURNAL_BYTES, FailureJournal } from "../failure-journal.mjs";

let fixture;

afterEach(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
    fixture = undefined;
});

async function createJournal(options = {}) {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-failures-"));
    return new FailureJournal({ path: join(fixture, "failure-journal.jsonl"), ...options });
}

describe("Notes failure journal", () => {
    test("deduplicates safe failures and removes exception text and absolute paths", async () => {
        const journal = await createJournal({
            environment: {
                notesVersion: "2.2.7", nodeVersion: "22.1.0", platform: "win32",
                osVersion: "10.0.22631", architecture: "x64",
                copilotAppVersion: "secret-home-path", copilotSdkVersion: "1.2.3",
            },
        });
        const operationId = "2e0f0bf2-a992-4dcb-b06b-0b57ea1e9e15";
        const event = {
            eventName: "notes.request.failure",
            errorCode: "io_error",
            attributes: {
                component: "provider", route: "/api/note/update", operationId,
                durationMs: 42, resultCode: "io_error", noteTitle: "SENTINEL_TITLE",
            },
            stack: "Error: SENTINEL_EXCEPTION\n    at update (C:\\Users\\SENTINEL_USER\\repo\\extensions\\notes\\server.mjs:12:8)\n    at outside (C:\\Users\\SENTINEL_USER\\node_modules\\other\\index.mjs:1:2)",
            recentOperations: [{
                route: "/api/note/update", resultCode: "io_error", operationId,
                durationMs: 42, noteBody: "SENTINEL_BODY",
            }],
        };
        expect(await journal.recordFailure(event)).toBe(true);
        expect(await journal.recordFailure(event)).toBe(true);

        const contents = await readFile(journal.path, "utf8");
        expect(contents).not.toContain("SENTINEL");
        expect(contents).not.toContain("C:\\Users");
        const [record] = contents.trim().split("\n").map(JSON.parse);
        expect(record).toMatchObject({
            eventName: "notes.request.failure",
            attributes: { errorCode: "io_error" },
            occurrences: 2,
            stack: [{ file: "extensions/notes/server.mjs", line: 12, column: 8 }],
        });
        expect(record.attributes).not.toHaveProperty("noteTitle");
        expect(record.recentOperations[0]).not.toHaveProperty("noteBody");

        const bundle = await journal.renderIssueBundle();
        expect(bundle).toContain('"schemaVersion":1');
        expect(bundle).toContain('"notesVersion":"2.2.7"');
        expect(bundle).toContain('"occurrences":2');
        expect(bundle).not.toContain("SENTINEL");
        expect(bundle).not.toContain("secret-home-path");
        expect(Buffer.byteLength(bundle)).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
    });

    test("does not persist expected outcomes and expires old incidents", async () => {
        let current = new Date("2026-01-01T00:00:00.000Z");
        const journal = await createJournal({ now: () => current });
        const event = {
            eventName: "notes.request.failure",
            errorCode: "conflict",
            attributes: { component: "provider", route: "/api/note/update" },
        };
        expect(await journal.recordFailure(event)).toBe(false);
        expect(await readFile(journal.path).catch(error => error.code)).toBe("ENOENT");

        await journal.recordFailure({ ...event, errorCode: "io_error" });
        current = new Date(current.getTime() + FAILURE_JOURNAL_RETENTION_MS + 1);
        await journal.recordFailure({ ...event, errorCode: "offline" });
        const records = (await readFile(journal.path, "utf8")).trim().split("\n").map(JSON.parse);
        expect(records).toHaveLength(1);
        expect(records[0]).not.toHaveProperty("errorCode");
        expect(records[0].attributes.errorCode).toBe("offline");
    });

    test("serializes writes from separate extension runs", async () => {
        const first = await createJournal();
        const second = new FailureJournal({ path: first.path });
        await Promise.all(Array.from({ length: 12 }, (_, index) =>
            (index % 2 ? first : second).recordFailure({
                eventName: "notes.tool.failure",
                errorCode: "io_error",
                attributes: { component: "tool", operation: "create" },
                stack: `Error\n    at create (C:\\repo\\extensions\\notes\\notes-tool.mjs:${index + 1}:2)`,
            })));
        const records = (await readFile(first.path, "utf8")).trim().split("\n").map(JSON.parse);
        expect(records).toHaveLength(12);
    });

    test("keeps successful operations in memory and attaches only the latest 20 to a failure", async () => {
        const journal = await createJournal();
        for (let index = 0; index < 25; index++) {
            journal.recordOperation({
                route: "/api/notes",
                resultCode: "ok",
                operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            });
        }
        expect(await readFile(journal.path).catch(error => error.code)).toBe("ENOENT");
        await journal.recordFailure({
            eventName: "notes.request.failure",
            errorCode: "io_error",
            attributes: { component: "provider", route: "/api/note/update" },
        });
        const [record] = (await readFile(journal.path, "utf8")).trim().split("\n").map(JSON.parse);
        expect(record.recentOperations).toHaveLength(20);
        expect(record.recentOperations[0].operationId).toBe("00000000-0000-4000-8000-000000000005");
    });

    test("isolates recorder failures and emits one sanitized local warning", async () => {
        const journal = await createJournal();
        const blockedPath = join(fixture, "blocked");
        await writeFile(blockedPath, "not a directory");
        journal.path = join(blockedPath, "failure-journal.jsonl");
        const warnings = [];
        journal.log = (message, options) => warnings.push({ message, options });
        const failure = {
            eventName: "notes.request.failure",
            errorCode: "io_error",
            attributes: { component: "provider", route: "/api/note/update" },
        };
        expect(await journal.recordFailure(failure)).toBe(false);
        expect(await journal.recordFailure(failure)).toBe(false);
        expect(warnings).toEqual([{
            message: "Notes diagnostic journal could not save a failure.",
            options: { level: "warning" },
        }]);
    });

    test("keeps the journal and rendered issue block within their byte limits", async () => {
        const journal = await createJournal();
        const timestamp = new Date().toISOString();
        const operations = Array.from({ length: 20 }, (_, index) => ({
            route: "/api/note/update",
            operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            resultCode: "io_error",
            durationMs: 50,
        }));
        const records = Array.from({ length: 3000 }, (_, index) => JSON.stringify({
            timestamp,
            eventName: "notes.request.failure",
            errorCode: "io_error",
            attributes: { component: "provider", route: "/api/note/update" },
            stack: [{ file: "extensions/notes/server.mjs", line: index + 1, column: 2 }],
            recentOperations: operations,
        }));
        await writeFile(journal.path, `${records.join("\n")}\n`);
        await journal.recordFailure({
            eventName: "notes.request.failure",
            errorCode: "offline",
            attributes: { component: "provider", route: "/api/note/update" },
        });
        expect(Buffer.byteLength(await readFile(journal.path))).toBeLessThanOrEqual(MAX_JOURNAL_BYTES);
        expect(Buffer.byteLength(await journal.renderIssueBundle())).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
    });
});
