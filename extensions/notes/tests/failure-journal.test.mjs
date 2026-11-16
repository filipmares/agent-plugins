import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    test("captures safe environment and standalone/session mode with each incident", async () => {
        const journal = await createJournal({
            environment: {
                notesVersion: "2.2.9", copilotAppVersion: "1.4.1", copilotSdkVersion: "1.0.0",
                nodeVersion: "24.22.1", platform: "win32", osVersion: "10.0.22631", architecture: "x64",
            },
        });
        const failure = {
            eventName: "notes.panel.startup_stalled",
            errorCode: "startup_incomplete",
            attributes: { component: "provider", openingMode: "standalone" },
        };
        expect(await journal.recordFailure(failure)).toBe(true);
        const updatedEnvironment = new FailureJournal({
            path: journal.path,
            environment: {
                notesVersion: "2.2.10", copilotAppVersion: "1.4.2", copilotSdkVersion: "1.0.0",
                nodeVersion: "24.22.1", platform: "win32", osVersion: "10.0.22631", architecture: "x64",
            },
        });
        expect(await updatedEnvironment.recordFailure(failure)).toBe(true);

        const records = (await readFile(journal.path, "utf8")).trim().split("\n").map(JSON.parse);
        expect(records).toHaveLength(2);
        expect(records.map(record => record.environment.copilotAppVersion).sort()).toEqual(["1.4.1", "1.4.2"]);
        expect(records[0].attributes).toMatchObject({ openingMode: "standalone" });
        const bundle = await journal.renderIssueBundle();
        expect(bundle).toContain('"schemaVersion":2');
        expect(bundle).toContain('"openingMode":"standalone"');
        expect(bundle).toContain('"copilotAppVersion":"1.4.1"');
        const incidents = bundle.split("\n").slice(2, -1).map(JSON.parse);
        expect(incidents.map(incident => incident.environment.copilotAppVersion).sort()).toEqual(["1.4.1", "1.4.2"]);
    });

    test("uses unknown values for unavailable environment metadata and rejects unsafe values", async () => {
        const journal = await createJournal({
            environment: { copilotAppVersion: "C:\\Users\\private\\app", nodeVersion: "24.22.1" },
        });
        await journal.recordFailure({
            eventName: "notes.panel.startup_stalled",
            errorCode: "startup_incomplete",
            attributes: { component: "provider", openingMode: "unexpected-private-value" },
        });
        const [record] = (await readFile(journal.path, "utf8")).trim().split("\n").map(JSON.parse);
        expect(record.environment).toMatchObject({
            copilotAppVersion: "unknown", copilotSdkVersion: "unknown", nodeVersion: "24.22.1",
            notesVersion: "2.2.13", platform: "unknown", osVersion: "unknown", architecture: "unknown",
        });
        expect(record.attributes).not.toHaveProperty("openingMode");
        expect(JSON.stringify(record)).not.toContain("C:\\Users");
    });

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
        expect(bundle).toContain('"schemaVersion":2');
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

    test("recovers a panel startup marker after its owning process exits", async () => {
        const journal = await createJournal();
        const finishStartup = await journal.beginPanelStartup("standalone");
        const pending = `${journal.path}.pending`;
        const [name] = await readdir(pending);
        expect(name).toMatch(/^[a-f\d]{32}\.json$/i);

        await journal.recoverAbandonedPanelStarts();
        expect(await readdir(pending)).toHaveLength(1);
        await finishStartup();
        expect(await readdir(pending)).toEqual([]);

        await mkdir(pending, { recursive: true });
        await writeFile(join(pending, `${"a".repeat(32)}.json`), JSON.stringify({
            pid: 2_147_483_647, startedAt: new Date().toISOString(), openingMode: "standalone",
        }));
        expect(await journal.recoverAbandonedPanelStarts()).toBe(1);
        const records = (await readFile(journal.path, "utf8")).trim().split("\n").map(JSON.parse);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            eventName: "notes.panel.startup_abandoned",
            attributes: { component: "provider", errorCode: "startup_abandoned", openingMode: "standalone" },
        });
        expect(await readdir(pending)).toEqual([]);
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
