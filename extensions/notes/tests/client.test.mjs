import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createNotesServer } from "../server.mjs";
import { NotesLibrary } from "../storage.mjs";
import { pushRecovery, recoveryPath } from "../ui-state.mjs";

const source = await readFile(new URL("../client/app.ts", import.meta.url), "utf8");
const instrumented = source.replace(/\bvoid start\(\);(?=\s*$)/, "globalThis.clientReady = start();");
if (instrumented === source) throw new Error("Cannot await Notes client startup.");
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(instrumented + `
globalThis.client = { state, textarea, toast, openNote, moveNote, save, resolveConflict };
`);
const context = { sessionId: "client-test", actor: "user" };
let fixture, root, library, server, statePath, clients;

// Execute the entire client, including event listeners, without a browser dependency.
// DOM/layout are inert: these tests exercise controller state and real server/storage effects.
class Element extends EventTarget {
    value = "";
    hidden = false;
    dataset = {};
    children = [];
    attributes = new Map();
    classList = { add() {}, remove() {}, toggle() {} };
    style = { setProperty() {} };
    setAttribute(name, value) {
        this.attributes.set(name, value);
        if (name === "hidden") this.hidden = true;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    contains() { return false; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

async function openClient() {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        body: new Element(), activeElement: null,
        createElement: () => new Element(),
        createElementNS: () => new Element(),
        getElementById: () => new Element(),
    });
    const pending = new Set();
    const calls = [];
    let afterMove;
    let timerId = 0;
    const timers = new Map();
    const sandbox = {
        window, document, URLSearchParams, Event, crypto,
        matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
        EventSource: class extends EventTarget {},
        __ICONS__: new Proxy({}, { get: () => ({ width: 16, path: "" }) }),
        addEventListener: window.addEventListener.bind(window),
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id),
        fetch(path, options = {}) {
            calls.push({ path, ...options, body: options.body && JSON.parse(options.body) });
            const result = (async () => {
                const response = await fetch(new URL(path, server.url), {
                    ...options, headers: { ...options.headers, Origin: new URL(server.url).origin },
                });
                if (path === "api/note/move") await afterMove?.();
                return response;
            })();
            pending.add(result);
            result.then(() => pending.delete(result), () => pending.delete(result));
            return result;
        },
    };
    window.setTimeout = sandbox.setTimeout;
    runInNewContext(script, sandbox);
    await sandbox.clientReady;
    const panel = {
        ...sandbox.client,
        calls,
        delayMove(handler) { afterMove = handler; },
        async settle() { while (pending.size) await Promise.all([...pending]); },
        async close() {
            window.dispatchEvent(new Event("pagehide"));
            await this.settle();
            timers.clear();
        },
    };
    clients.push(panel);
    expect(panel.toast.hidden).toBe(true);
    return panel;
}

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-client-"));
    root = join(fixture, "notes");
    library = new NotesLibrary(root, { trash: async () => { throw new Error("Unexpected trash call"); } });
    statePath = join(fixture, "state", "ui.json");
    clients = [];
    server = await createNotesServer({
        getLibrary: async () => library, getContext: async () => context, sessionId: context.sessionId, statePath,
    });
});

afterEach(async () => {
    await Promise.all(clients.map(panel => panel.settle()));
    await server.close();
    await rm(fixture, { recursive: true, force: true });
});

describe("Notes client persistence", () => {
    test.each([false, true])("close/reopen preserves unresolved recovery until explicit resolution (keep mine: %s)", async keepMine => {
        const note = await library.create({ body: "# Shared\nCurrent external text" }, context);
        const recovery = { noteId: note.id, folder: "", body: "# Shared\nOlder recovered draft" };
        await pushRecovery(recoveryPath(statePath), recovery);
        let panel = await openClient();
        for (let reopen = 0; reopen < 2; reopen++) {
            expect(panel.textarea.value).toBe(recovery.body);
            expect(panel.state.conflict).toBe(true);
            expect(panel.state.recovered).toBe(true);
            await panel.close();
            expect(panel.calls.at(-1)).toMatchObject({
                path: "api/note/rescue", keepalive: true,
                body: { id: note.id, expectedVersion: note.version, body: recovery.body, stash: true },
            });
            expect(await library.read(note.id)).toMatchObject({ body: note.body, version: note.version });
            panel = await openClient();
        }
        await panel.resolveConflict(keepMine);
        const expected = keepMine ? recovery.body : note.body;
        expect(panel.state.conflict).toBe(false);
        expect(panel.textarea.value).toBe(expected);
        expect((await library.read(note.id)).body).toBe(expected);
        await panel.close();
        const reopened = await openClient();
        expect(reopened.state.recovered).toBe(false);
        expect(reopened.state.conflict).toBe(false);
    });

    test.each([
        [false, false], [false, true], [true, false], [true, true],
    ])("collision move keeps rewritten links or conflicts with typing (malformed: %s, typing: %s)", async (malformed, typing) => {
        await mkdir(join(root, "plan.assets"), { recursive: true });
        await mkdir(join(root, "Work"));
        const body = `${malformed ? "---\nid: invalid\n---\n" : ""}# Plan\n![pic](plan.assets/p.png)`;
        await writeFile(join(root, "plan.md"), body);
        await writeFile(join(root, "plan.assets", "p.png"), "pixels");
        await writeFile(join(root, "Work", "plan.md"), "# Destination");
        const note = await library.read("plan.md");
        expect(note.id === null).toBe(malformed);
        const panel = await openClient();
        await panel.openNote(note.id ?? note.path);
        const typed = body + "\nTyped during the move";
        const rewritten = body.replace("plan.assets", "plan-2.assets");
        let release, moving;
        const movedOnDisk = new Promise(resolve => { moving = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        panel.delayMove(() => { moving(); return gate; });
        const move = panel.moveNote(panel.state.note, "Work");
        await movedOnDisk;
        if (typing) {
            panel.textarea.value = typed;
            panel.textarea.dispatchEvent(new Event("input"));
        }
        release();
        await move;
        expect(panel.toast.hidden).toBe(true);
        expect(panel.state.note.path).toBe("Work/plan-2.md");
        expect(panel.state.note.id).toBe(note.id);
        expect(panel.state.note.body).toBe(rewritten);
        expect(panel.state.conflict).toBe(typing);
        expect((await library.read("Work/plan-2.md")).body).toBe(rewritten);
        expect(await readFile(join(root, "Work", "plan-2.assets", "p.png"), "utf8")).toBe("pixels");
        if (typing) {
            expect(panel.textarea.value).toBe(typed);
            expect(await panel.save()).toBe(false);
            expect(panel.calls.filter(call => call.path === "api/note/update")).toHaveLength(0);
            await panel.close();
            expect((await library.read("Work/plan-2.md")).body).toBe(rewritten);
            const reopened = await openClient();
            expect(reopened.state.note.path).toBe("Work/plan-2.md");
            expect(reopened.textarea.value).toBe(typed);
            expect(reopened.state.conflict).toBe(true);
        } else {
            expect(panel.textarea.value).toBe(rewritten);
            expect(panel.state.sent).toBe(rewritten);
            panel.textarea.value += "\nAfter the move";
            expect(await panel.save()).toBe(true);
            expect((await library.read("Work/plan-2.md")).body).toBe(rewritten + "\nAfter the move");
        }
    });

    test("Keep Mine writes text undone to the old saved body instead of treating it as clean", async () => {
        const note = await library.create({ body: "# Note\nOriginal" }, context);
        const panel = await openClient();
        await panel.openNote(note.id);
        const external = await library.update(note.id, { body: "# Note\nExternal", expectedVersion: note.version }, context);
        panel.textarea.value = "# Note\nMy edit";
        expect(await panel.save()).toBe(false);
        expect(panel.state.conflict).toBe(true);
        panel.textarea.value = note.body;
        await panel.resolveConflict(true);
        expect(panel.calls.filter(call => call.path === "api/note/update").at(-1).body)
            .toMatchObject({ id: note.id, body: note.body, expectedVersion: external.version });
        expect((await library.read(note.id)).body).toBe(note.body);
        expect(panel.state.conflict).toBe(false);
    });
});
