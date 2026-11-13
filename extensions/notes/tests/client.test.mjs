import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createNotesServer } from "../server.mjs";
import { NotesLibrary } from "../storage.mjs";
import { pushRecovery, recoveryPath, saveUiState } from "../ui-state.mjs";

const source = await readFile(new URL("../client/app.ts", import.meta.url), "utf8");
const instrumented = source.replace(/^import .+;$/gm, "").replace(/\bvoid start\(\);(?=\s*$)/, "globalThis.clientReady = start();");
if (instrumented === source) throw new Error("Cannot await Notes client startup.");
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(instrumented + `
globalThis.client = { state, textarea, toast, openNote, moveNote, save, resolveConflict, refresh, askInput, askStatus, askPanel, copilotButton, compose, toggleMarkdown, frontmatterView, frontmatterContext, frontmatterDetails, frontmatterMore, isPlain: () => plain };
`);
const context = { sessionId: "client-test", actor: "user" };
let fixture, root, library, server, statePath, clients;

// Execute the entire client, including event listeners, without a browser dependency.
// DOM/layout are inert: these tests exercise controller state and real server/storage effects.
class Element extends EventTarget {
    constructor(tagName = "div") { super(); this.tagName = tagName; }
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
    parentNode = null;
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
    adopt(children) {
        for (const child of children) {
            if (!(child instanceof Element)) continue;
            child.remove();
            child.parentNode = this;
        }
        return children;
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    append(...children) { this.children.push(...this.adopt(children)); }
    before(node) {
        const parent = this.parentNode;
        parent.adopt([node]);
        parent.children.splice(parent.children.indexOf(this), 0, node);
    }
    replaceChildren(...children) {
        for (const child of this.children) if (child instanceof Element) child.parentNode = null;
        this.children = this.adopt(children);
    }
    contains() { return false; }
    focus() {}
    setSelectionRange() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
}

async function openClient({ richSafe = false } = {}) {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        body: new Element(), activeElement: null,
        createElement: tag => new Element(tag),
        createElementNS: () => new Element(),
        getElementById: () => new Element(),
    });
    const pending = new Set();
    const calls = [];
    const headers = [];
    let afterMove;
    let timerId = 0;
    const timers = new Map();
    const sandbox = {
        window, document, URLSearchParams, Event, crypto,
        GUARD_MESSAGE: "This note uses Markdown the rich editor can't keep exactly.",
        safeExternal: value => /^(https?:|mailto:)/.test(value),
        // Only the rendered view is inert. Real codec/schema and browser tests cover the rich view separately.
        createRichEditor: ({ header }) => {
            headers.push(header);
            return { safe: richSafe, editor: { destroy() {}, commands: { focus() {} }, isFocused: false, state: { selection: { from: 1 } } } };
        },
        matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
        EventSource: class extends EventTarget { close() {} },
        __ICONS__: new Proxy({}, { get: (_target, name) => ({ width: 16, path: String(name) }) }),
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
        richHeader: () => headers.at(-1),
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

const startServer = (options = {}) => createNotesServer({
    getLibrary: async () => library, getContext: async () => context, sessionId: context.sessionId, statePath, ...options,
});

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-client-"));
    root = join(fixture, "notes");
    library = new NotesLibrary(root, { trash: async () => { throw new Error("Unexpected trash call"); } });
    statePath = join(fixture, "state", "ui.json");
    clients = [];
    server = await startServer();
});

afterEach(async () => {
    await Promise.all(clients.map(panel => panel.settle()));
    await server.close();
    await rm(fixture, { recursive: true, force: true });
});

describe("Notes client persistence", () => {
    const descendants = element => element.children.flatMap(child => child instanceof Element ? [child, ...descendants(child)] : []);
    const text = node => typeof node === "string" ? node : node.children.map(text).join("");
    const property = (panel, key) => descendants(panel.frontmatterView).find(node => node.getAttribute("data-property") === key);

    test("frontmatter shows only creator and origin context, with read-only details that never save a draft", async () => {
        const note = await library.create({ body: "# Metadata\nOriginal" }, {
            ...context, actor: "agent", project: "owner/repo", branch: "feature/notes", sessionName: "Metadata session",
        });
        const path = join(root, note.path);
        const raw = await readFile(path, "utf8");
        await writeFile(path, raw.replace("\n---\n",
            '\nstatus: ready\nreview: {required: false, round: 0}\nempty: ""\nnil: null\nconstructor: custom\ntext: "<img src=x onerror=alert(1)>"\n---\n'));
        const before = await readFile(path);
        const panel = await openClient();
        expect(panel.frontmatterView.hidden).toBe(true);
        await panel.openNote(note.id);
        expect(panel.frontmatterView.hidden).toBe(false);
        expect(panel.frontmatterDetails.hidden).toBe(true);
        expect(panel.frontmatterContext.children.map(node => node.getAttribute("data-property")))
            .toEqual(["created_by", "project", "session_name"]);
        expect(text(property(panel, "created_by"))).toBe("Created by Agent");
        expect(property(panel, "created_by").children[0].innerHTML).toBe("copilot");
        expect(text(panel.frontmatterMore)).toBe("More");
        panel.frontmatterMore.dispatchEvent(new Event("click"));
        expect(panel.frontmatterDetails.hidden).toBe(false);
        expect(panel.frontmatterMore.getAttribute("aria-expanded")).toBe("true");
        expect(panel.frontmatterDetails.children.map(node => node.getAttribute("aria-label")))
            .toEqual(["Properties", "Dates and origin", "Technical details"]);
        expect(text(property(panel, "pinned"))).toBe("PinnedNo");
        expect(text(property(panel, "review"))).toContain('"required": false');
        expect(text(property(panel, "review"))).toContain('"round": 0');
        expect(text(property(panel, "empty"))).toBe("empty(empty string)");
        expect(text(property(panel, "nil"))).toBe("nilnull");
        expect(text(property(panel, "constructor"))).toBe("constructorcustom");
        expect(text(property(panel, "text"))).toContain("<img src=x onerror=alert(1)>");
        expect(descendants(panel.frontmatterDetails).some(node =>
            ["input", "textarea", "select", "button", "img", "script"].includes(node.tagName))).toBe(false);

        panel.textarea.value = "# Metadata\nPending body edit";
        panel.frontmatterMore.dispatchEvent(new Event("click"));
        property(panel, "session_name").dispatchEvent(new Event("click"));
        expect(property(panel, "session_name").getAttribute("aria-expanded")).toBe("true");
        expect(panel.calls.filter(call => call.method === "POST" && call.path.startsWith("api/note/"))).toHaveLength(0);
        expect(panel.textarea.value).toBe("# Metadata\nPending body edit");
        expect(await readFile(path)).toEqual(before);
    });

    test("details refresh after external changes and body saves, retaining disclosure state only for the same note", async () => {
        const note = await library.create({ body: "# Live metadata" }, { ...context, project: "origin" });
        const other = await library.create({ body: "# Other" }, context);
        const panel = await openClient();
        await panel.openNote(note.id);
        panel.frontmatterMore.dispatchEvent(new Event("click"));
        property(panel, "project").dispatchEvent(new Event("click"));
        await library.pin(note.id, true, note.version);
        await panel.refresh();
        expect(text(property(panel, "pinned"))).toBe("PinnedYes");
        expect(panel.frontmatterDetails.hidden).toBe(false);
        expect(property(panel, "project").getAttribute("aria-expanded")).toBe("true");
        panel.textarea.value += "\nAn ordinary body edit";
        expect(await panel.save()).toBe(true);
        const saved = await library.read(note.id);
        expect(descendants(property(panel, "updated")).find(node => node.tagName === "time").getAttribute("datetime"))
            .toBe(saved.frontmatter.updated);
        expect(panel.frontmatterDetails.hidden).toBe(false);
        await panel.openNote(other.id);
        expect(panel.frontmatterDetails.hidden).toBe(true);
        expect(property(panel, "project")).toBeUndefined();
        await panel.openNote(note.id);
        expect(property(panel, "project").getAttribute("aria-expanded")).toBe("false");
    });

    test("human notes omit unavailable provenance, and drafts or malformed notes have no metadata view", async () => {
        const note = await library.create({ body: "# Human" }, { actor: "user" });
        const panel = await openClient();
        await panel.openNote(note.id);
        expect(text(property(panel, "created_by"))).toBe("Created by Human");
        expect(property(panel, "created_by").children[0].innerHTML).toBe("person");
        for (const key of ["project", "branch", "session_name", "session_id"]) expect(property(panel, key)).toBeUndefined();
        expect(text(property(panel, "sessions"))).toBe("Editing sessionsNo sessions recorded");
        await panel.compose();
        expect(panel.frontmatterView.hidden).toBe(true);
        const raw = "---\ninvalid: [\n---\n# Repair me";
        await writeFile(join(root, "broken.md"), raw);
        await panel.openNote("broken.md");
        expect(panel.frontmatterView.hidden).toBe(true);
        expect(panel.textarea.value).toBe(raw);
        expect(await readFile(join(root, "broken.md"), "utf8")).toBe(raw);
    });

    test("properties sit below the opening heading in rich view and above the text in Markdown view", async () => {
        const note = await library.create({ body: "# Placement\nbody" }, { ...context, project: "origin" });
        const panel = await openClient({ richSafe: true });
        await panel.openNote(note.id);
        const slot = panel.richHeader();
        expect(slot.getAttribute("class")).toBe("frontmatter-slot");
        expect(panel.frontmatterView.parentNode).toBe(slot);
        panel.toggleMarkdown();
        expect(panel.frontmatterView.nextSibling).toBe(panel.textarea);
        // Returning to rich view, or reloading after an external change, rebuilds the editor and its slot.
        panel.toggleMarkdown();
        const rebuilt = panel.richHeader();
        expect(rebuilt).not.toBe(slot);
        expect(panel.frontmatterView.parentNode).toBe(rebuilt);
        expect(slot.children).toEqual([]);
        await library.update(note.id, { body: "# Placement\nexternal", expectedVersion: note.version }, context);
        await panel.refresh();
        expect(panel.richHeader()).not.toBe(rebuilt);
        expect(panel.frontmatterView.parentNode).toBe(panel.richHeader());
    });

    test("same-note sync retains Markdown view while a different note chooses its own mode", async () => {
        const note = await library.create({ body: "# Plain view\noriginal" }, context);
        const other = await library.create({ body: "# Other\nrich" }, context);
        const panel = await openClient({ richSafe: true });
        await panel.openNote(note.id);
        expect(panel.isPlain()).toBe(false);
        panel.toggleMarkdown();
        const changed = await library.update(note.id, { body: "# Plain view\nexternal", expectedVersion: note.version }, context);
        await panel.refresh();
        expect(panel.isPlain()).toBe(true);
        expect(panel.textarea.hidden).toBe(false);
        expect(panel.textarea.value).toBe(changed.body);
        await panel.openNote(other.id);
        expect(panel.isPlain()).toBe(false);
    });

    test("live sync silently reloads clean text but preserves dirty and unresolved drafts", async () => {
        const note = await library.create({ body: "# Sync\noriginal" }, context);
        const panel = await openClient();
        await panel.openNote(note.id);
        const first = await library.update(note.id, { body: "# Sync\nexternal 1", expectedVersion: note.version }, context);
        await panel.refresh();
        expect(panel.textarea.value).toBe(first.body);
        expect(panel.state.conflict).toBe(false);
        panel.textarea.value = "# Sync\nmy draft";
        const second = await library.update(note.id, { body: "# Sync\nexternal 2", expectedVersion: first.version }, context);
        await panel.refresh();
        expect(panel.textarea.value).toBe("# Sync\nmy draft");
        expect(panel.state.conflict).toBe(true);
        // Undo is not an implicit conflict resolution; closing must still stash.
        panel.textarea.value = first.body;
        await panel.refresh();
        expect(panel.textarea.value).toBe(first.body);
        expect(panel.state.conflict).toBe(true);
        await panel.close();
        expect(panel.calls.at(-1).body.stash).toBe(true);
        expect((await library.read(note.id)).body).toBe(second.body);
    });

    test("Ask Copilot flushes edits, leaves conflicts unsent, and reports a disconnected session", async () => {
        const note = await library.create({ body: "# Ask\noriginal" }, context);
        const panel = await openClient();
        await panel.openNote(note.id);
        panel.textarea.value = "# Ask\nsaved before sending";
        panel.askInput.value = "Summarize";
        panel.askInput.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" }));
        await panel.settle();
        expect((await library.read(note.id)).body).toBe("# Ask\nsaved before sending");
        expect(panel.calls.findLast(call => call.path === "api/ask").body).toMatchObject({ id: note.id, prompt: "Summarize" });
        expect(panel.askStatus.textContent).toBe("Not sent");
        const count = panel.calls.filter(call => call.path === "api/ask").length;
        panel.state.conflict = true;
        panel.askInput.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" }));
        await panel.settle();
        expect(panel.calls.filter(call => call.path === "api/ask")).toHaveLength(count);
    });

    test("Ask Copilot hides on Escape and after sending, but stays open with the prompt when sending fails", async () => {
        await server.close();
        const sent = [];
        let fail = true;
        server = await startServer({ sendMessage: async message => {
            if (fail) throw new Error("busy");
            sent.push(message);
            return "message-1";
        } });
        const note = await library.create({ body: "# Ask\nsend me" }, context);
        const panel = await openClient();
        await panel.openNote(note.id);
        expect(panel.copilotButton.hidden).toBe(false);
        const press = key => panel.askInput.dispatchEvent(Object.assign(new Event("keydown"), { key }));
        const settled = async status => {
            for (let i = 0; i < 200 && panel.askStatus.textContent !== status; i++) await Bun.sleep(5);
            expect(panel.askStatus.textContent).toBe(status);
        };
        panel.copilotButton.dispatchEvent(new Event("click"));
        expect(panel.askPanel.hidden).toBe(false);
        press("Escape");
        expect(panel.askPanel.hidden).toBe(true);
        expect(panel.copilotButton.getAttribute("aria-expanded")).toBe("false");

        panel.copilotButton.dispatchEvent(new Event("click"));
        panel.askInput.value = "Summarize";
        press("Enter");
        await settled("Not sent");
        expect(panel.askPanel.hidden).toBe(false);
        expect(panel.askInput.value).toBe("Summarize");

        fail = false;
        press("Enter");
        await settled("Sent to chat");
        expect(sent).toMatchObject([{ prompt: "Summarize" }]);
        expect(panel.askPanel.hidden).toBe(true);
        expect(panel.copilotButton.getAttribute("aria-expanded")).toBe("false");
        expect(panel.askInput.value).toBe("");
    });

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

    test("a panel opened without a session hides Ask Copilot, falls back from a remembered session view, and still saves", async () => {
        await server.close();
        server = await startServer({ getContext: async () => ({}), sessionId: "app-control-session" });
        await saveUiState(statePath, { sidebar: true, selection: { view: "session" }, noteId: null, collapsed: [] });
        const panel = await openClient();
        expect(panel.state.context).toEqual({ sessionId: null, project: null, sessionName: null });
        expect(panel.state.ui.selection).toEqual({ view: "all" });
        expect(panel.copilotButton.hidden).toBe(true);

        await panel.compose();
        panel.textarea.value = "# Loose\nNo session";
        expect(await panel.save()).toBe(true);
        expect(panel.toast.hidden).toBe(true);
        const [saved] = (await library.list()).notes;
        expect((await library.read(saved.id)).frontmatter).toMatchObject({ created_by: "user", sessions: [] });
        expect((await library.read(saved.id)).frontmatter).not.toHaveProperty("session_id");
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
