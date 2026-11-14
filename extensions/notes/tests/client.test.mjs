import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { FailureJournal } from "../failure-journal.mjs";
import { createNotesServer } from "../server.mjs";
import { NotesLibrary } from "../storage.mjs";
import { pushRecovery, recoveryPath, saveUiState } from "../ui-state.mjs";

const source = await readFile(new URL("../client/app.ts", import.meta.url), "utf8");
const instrumented = source.replace(/^import .+;$/gm, "").replace(/\bvoid start\(\);(?=\s*$)/, "globalThis.clientReady = start();");
if (instrumented === source) throw new Error("Cannot await Notes client startup.");
// The sandbox supplies the lazy editor loader, so each test can delay or fail it.
const lazy = instrumented.replace(/^const importEditor = .+;$/m, "");
if (lazy === instrumented) throw new Error("Cannot replace the Notes editor loader.");
const script = new Bun.Transpiler({ loader: "ts" }).transformSync(lazy + `
globalThis.client = { state, textarea, toast, openNote, moveNote, save, resolveConflict, refresh, select, askInput, askStatus, askPanel, copilotButton, compose, toggleMarkdown, rows, renderList, listCount, formattingHelp,
    flushDiagnostics,
    frontmatterView, frontmatterContext, frontmatterDetails, frontmatterMore, isPlain: () => plain,
    editorLoading, richElement, markdownButton, focusEditor, isWaiting: () => editorWaiting, listStatus: () => listStatus,
    saveButton, saveDetails, saveAnnouncement, saving: () => inflight,
    app, sidebar, listPane, editorPane, sidebarToggle, showFoldersButton, backToNotesButton, backdrop, setOverlay, rememberFocus, closeOverlayOnEscape, overlayOpen: () => overlay };
`);
const context = { sessionId: "client-test", actor: "user" };
let fixture, root, library, server, statePath, diagnostics, clients;
let scrollIntoViewTotal = 0;

// Execute the entire client, including event listeners, without a browser dependency.
// DOM/layout are inert: these tests exercise controller state and real server/storage effects.
class Element extends EventTarget {
    constructor(tagName = "div") { super(); this.tagName = tagName; }
    value = "";
    hidden = false;
    disabled = false;
    inert = false;
    dataset = {};
    children = [];
    attributes = new Map();
    classList = { add() {}, remove() {}, toggle() {} };
    style = { setProperty() {} };
    scrollTop = 0;
    lastFocusOptions;
    ownerDocument;
    parentElement;
    returnFocus;
    setAttribute(name, value) {
        this.attributes.set(name, value);
        if (name === "hidden") this.hidden = true;
        if (name === "disabled") this.disabled = true;
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    get parentNode() { return this.parentElement ?? null; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
    adopt(child) {
        if (!(child instanceof Element)) return;
        child.remove();
        child.parentElement = this;
        child.ownerDocument = this.ownerDocument;
    }
    append(...children) {
        for (const child of children) {
            this.adopt(child);
            this.children.push(child);
        }
    }
    before(node) {
        const parent = this.parentElement;
        parent.adopt(node);
        parent.children.splice(parent.children.indexOf(this), 0, node);
    }
    replaceChildren(...children) {
        for (const child of this.children) if (child instanceof Element) child.parentElement = null;
        this.children = [];
        this.append(...children);
    }
    contains(target) { return target === this || this.children.some(child => child instanceof Element && child.contains(target)); }
    focus(options) {
        const modal = this.ownerDocument?.body.querySelectorAll("dialog").find(dialog => dialog.hasAttribute("open"));
        if (modal && !modal.contains(this)) return;
        for (let element = this; element; element = element.parentElement) {
            if (element.hidden || element.inert) return;
        }
        this.lastFocusOptions = options;
        if (this.ownerDocument) this.ownerDocument.activeElement = this;
    }
    scrollIntoView() { scrollIntoViewTotal++; }
    setSelectionRange() {}
    select() {}
    getClientRects() { return [{}]; }
    showModal() { this.returnFocus = this.ownerDocument.activeElement; this.setAttribute("open", ""); }
    close() {
        this.attributes.delete("open");
        this.dispatchEvent(new Event("close"));
        this.returnFocus?.focus();
    }
    remove() {
        const index = this.parentElement?.children.indexOf(this) ?? -1;
        if (index >= 0) this.parentElement.children.splice(index, 1);
        this.parentElement = null;
    }
    closest(selector) {
        for (let element = this; element; element = element.parentElement) {
            if (selector === "dialog[open]" && element.tagName === "dialog" && element.hasAttribute("open")) return element;
        }
        return null;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
        const descendants = this.children.flatMap(child => child instanceof Element ? [child, ...child.querySelectorAll("*")] : []);
        if (selector === "*") return descendants;
        if (selector === "[aria-current='true']") return descendants.filter(element => element.getAttribute("aria-current") === "true");
        if (selector === "button" || selector.startsWith("button")) return descendants.filter(element => element.tagName === "button");
        if (selector === "input" || selector === "dialog") return descendants.filter(element => element.tagName === selector);
        const match = selector.match(/\.([\w-]+)(?::not\(\.([\w-]+)\))?/);
        if (!match) return [];
        const [, className, exclusion] = match;
        return descendants.filter(child => {
            const classes = child.getAttribute("class")?.split(/\s+/) ?? [];
            return classes.includes(className) && (!exclusion || !classes.includes(exclusion));
        });
    }
}

async function openClient({ richSafe = false, importEditor, respond, startupToast = false } = {}) {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), {
        body: new Element("body"), activeElement: null,
        createElement: tag => Object.assign(new Element(tag), { ownerDocument: document }),
        createElementNS: () => Object.assign(new Element("svg"), { ownerDocument: document }),
        getElementById: () => new Element(),
    });
    document.body.ownerDocument = document;
    const pending = new Set();
    const calls = [];
    const headers = [];
    let afterMove;
    let afterNotes;
    let beforeSave;
    let richCallbacks;
    let timerId = 0;
    const timers = new Map();
    const media = new Map();
    let eventSources = 0;
    const sandbox = {
        window, document, URLSearchParams, Event, crypto, queueMicrotask,
        GUARD_MESSAGE: "This note uses Markdown the rich editor can't keep exactly.",
        safeExternal: value => /^(https?:|mailto:)/.test(value),
        // Only the rendered view is inert. Real codec/schema and browser tests cover the rich view separately.
        createRichEditor: callbacks => {
            richCallbacks = callbacks;
            headers.push(callbacks.header);
            return { safe: richSafe, editor: { destroy() {}, commands: { focus() {} }, isFocused: false, state: { selection: { from: 1 } } } };
        },
        importEditor: () => importEditor ? importEditor({ createRichEditor: sandbox.createRichEditor }) : Promise.resolve({ createRichEditor: sandbox.createRichEditor }),
        matchMedia: query => {
            const result = Object.assign(new EventTarget(), { matches: false });
            media.set(query, result);
            return result;
        },
        EventSource: class extends EventTarget { constructor() { super(); eventSources += 1; } close() {} },
        __ICONS__: new Proxy({}, { get: (_target, name) => ({ width: 16, path: String(name) }) }),
        addEventListener: window.addEventListener.bind(window),
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: id => timers.delete(id),
        fetch(path, options = {}) {
            calls.push({ path, ...options, body: options.body && JSON.parse(options.body) });
            const result = (async () => {
                const canned = respond?.(path, sandbox.client, window);
                if (canned) return canned;
                if (path === "api/note/update" || path === "api/note/create") {
                    const replacement = await beforeSave?.();
                    if (replacement) return replacement;
                }
                const response = await fetch(new URL(path, server.url), {
                    ...options, headers: { ...options.headers, Origin: new URL(server.url).origin },
                });
                if (path === "api/note/move") await afterMove?.();
                if (path.startsWith("api/notes?")) await afterNotes?.();
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
        eventSources: () => eventSources,
        richHeader: () => headers.at(-1),
        scrollCalls: () => scrollIntoViewTotal,
        document,
        window,
        app: sandbox.client.app,
        sidebar: sandbox.client.sidebar,
        listPane: sandbox.client.listPane,
        editorPane: sandbox.client.editorPane,
        sidebarToggle: sandbox.client.sidebarToggle,
        showFoldersButton: sandbox.client.showFoldersButton,
        backToNotesButton: sandbox.client.backToNotesButton,
        backdrop: sandbox.client.backdrop,
        rememberFocus: sandbox.client.rememberFocus,
        closeOverlayOnEscape: sandbox.client.closeOverlayOnEscape,
        media,
        get activeElement() { return document.activeElement; },
        get overlayOpen() { return sandbox.client.overlayOpen(); },
        async setViewport({ wide, narrow }) {
            const wideMedia = media.get("(min-width: 960px)");
            const narrowMedia = media.get("(max-width: 639.98px)");
            const changedWide = wideMedia.matches !== wide;
            const changedNarrow = narrowMedia.matches !== narrow;
            wideMedia.matches = wide;
            narrowMedia.matches = narrow;
            if (changedWide) wideMedia.dispatchEvent(new Event("change"));
            if (changedNarrow) narrowMedia.dispatchEvent(new Event("change"));
        },
        delayMove(handler) { afterMove = handler; },
        delayNotes(handler) { afterNotes = handler; },
        interceptSave(handler) { beforeSave = handler; },
        richError(text) { richCallbacks.error(text); },
        richFailure(error) { richCallbacks.failure(error); },
        richChange(text) { richCallbacks.change(text); },
        runTimers(delay) {
            for (const [id, timer] of [...timers]) {
                if (timer.delay === delay) { timers.delete(id); timer.callback(); }
            }
        },
        async settle() { while (pending.size) await Promise.all([...pending]); },
        async close() {
            window.dispatchEvent(new Event("pagehide"));
            await this.settle();
            timers.clear();
        },
    };
    clients.push(panel);
    if (!startupToast) expect(panel.toast.hidden).toBe(true);
    return panel;
}

const startServer = (options = {}) => createNotesServer({
    getLibrary: async () => library, getContext: async () => context, sessionId: context.sessionId, statePath, diagnostics, ...options,
});

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-client-"));
    root = join(fixture, "notes");
    library = new NotesLibrary(root, { trash: async () => { throw new Error("Unexpected trash call"); } });
    statePath = join(fixture, "state", "ui.json");
    diagnostics = new FailureJournal({ path: join(fixture, "state", "failure-journal.jsonl") });
    clients = [];
    server = await startServer();
});

afterEach(async () => {
    await Promise.all(clients.map(panel => panel.settle()));
    await server.close();
    await rm(fixture, { recursive: true, force: true });
});

test("records a rich-editor boundary failure without its message", async () => {
    const panel = await openClient({ richSafe: true });
    await panel.compose();
    panel.richFailure(new Error("SENTINEL_EDITOR_EXCEPTION"));
    panel.window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "SENTINEL_REJECTION" }));
    await panel.flushDiagnostics();
    await panel.settle();
    const journal = await readFile(diagnostics.path, "utf8");
    expect(journal).toContain("notes.browser.editor_failure");
    expect(journal).toContain("notes.browser.unhandled_rejection");
    expect(journal).not.toContain("SENTINEL_EDITOR_EXCEPTION");
    expect(journal).not.toContain("SENTINEL_REJECTION");
});

test("sends a correlated browser request failure with only route and operation context", async () => {
    const panel = await openClient();
    await panel.compose();
    panel.interceptSave(() => { throw new Error("SENTINEL_TRANSPORT_ERROR"); });
    panel.textarea.value = "# Private note body";
    panel.textarea.dispatchEvent(new Event("input"));
    expect(await panel.save()).toBe(false);
    await panel.settle();
    const entries = (await readFile(diagnostics.path, "utf8")).trim().split("\n").map(JSON.parse);
    const failure = entries.find(entry => entry.eventName === "notes.browser.request_failure");
    expect(failure.attributes.route).toBe("/api/note/create");
    expect(failure.attributes.operationId).toMatch(/^[\da-f-]{36}$/i);
    expect(failure.recentOperations.at(-1)).toMatchObject({
        route: "/api/note/create", resultCode: "offline", operationId: failure.attributes.operationId,
    });
    expect(JSON.stringify(entries)).not.toContain("SENTINEL");
    expect(JSON.stringify(entries)).not.toContain("Private note body");
});

test("records the startup step a stuck panel is waiting on, and nothing once startup is claimed", async () => {
    const started = await openClient();
    started.runTimers(30_000);
    await started.flushDiagnostics();
    const busy = await openClient({
        startupToast: true,
        respond: path => path === "api/startup"
            ? new Response(JSON.stringify({ error: { code: "library_busy", message: "Still loading." } }), { status: 503 })
            : undefined,
    });
    busy.runTimers(30_000);
    await busy.flushDiagnostics();
    await busy.settle();
    const stalled = (await readFile(diagnostics.path, "utf8")).trim().split("\n").map(JSON.parse)
        .filter(entry => entry.eventName === "notes.browser.startup_stalled");
    expect(stalled.map(entry => entry.attributes.errorCode)).toEqual(["startup_claim_pending"]);
});

describe("save-state toolbar icon", () => {
    test("idle is hidden; new and saved notes have readable, toggleable status without autosave announcements", async () => {
        const panel = await openClient();
        expect(panel.saveButton.hidden).toBe(true);
        await panel.compose();
        expect(panel.saveButton.hidden).toBe(false);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("New note - not saved yet");
        expect(panel.saveDetails.hidden).toBe(true);
        panel.saveButton.focus();
        panel.saveButton.dispatchEvent(new Event("click"));
        expect(panel.saveDetails.hidden).toBe(false);
        expect(panel.saveButton.getAttribute("aria-expanded")).toBe("true");
        expect(panel.activeElement).toBe(panel.saveButton);
        panel.saveButton.dispatchEvent(new Event("click"));
        expect(panel.saveDetails.hidden).toBe(true);

        const note = await library.create({ body: "# Status\noriginal" }, context);
        await panel.openNote(note.id);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
        expect(panel.saveDetails.hidden).toBe(true);
        panel.textarea.value += "\nEdited";
        panel.textarea.dispatchEvent(new Event("input"));
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Unsaved changes");
        expect(await panel.save()).toBe(true);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
        expect(panel.saveAnnouncement.textContent).toBe("");
    });

    test.each([["server", false], ["transport", false], ["server", true], ["transport", true]])("a %s failure stays visible until Retry saves the current text (new draft: %s)", async (kind, draft) => {
        const note = draft ? null : await library.create({ body: "# Status\noriginal" }, context);
        const other = await library.create({ body: "# Other\nclean" }, context);
        const panel = await openClient();
        if (draft) await panel.compose();
        else await panel.openNote(note.id);
        panel.interceptSave(() => {
            if (kind === "transport") throw new Error("Connection refused");
            return new Response(JSON.stringify({ error: { code: "io_error", message: "Synthetic save failure" } }), { status: 500 });
        });
        panel.textarea.value = "# Status\nunsaved";
        panel.textarea.dispatchEvent(new Event("input"));
        expect(await panel.save()).toBe(false);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Save failed - Retry save");
        expect(panel.saveDetails.hidden).toBe(false);
        expect(panel.saveDetails.textContent).toContain(kind === "server" ? "Synthetic save failure" : "Notes is not responding");
        const announcement = panel.saveAnnouncement.textContent;
        panel.runTimers(6000);
        panel.textarea.value += "\nMore typing";
        panel.textarea.dispatchEvent(new Event("input"));
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Save failed - Retry save");
        expect(panel.saveAnnouncement.textContent).toBe(announcement);
        if (draft) expect((await library.list()).notes).toHaveLength(1);
        else expect((await library.read(note.id)).body).toBe(note.body);

        let release, started;
        const reachedSave = new Promise(resolve => { started = resolve; });
        panel.interceptSave(() => { started(); return new Promise(resolve => { release = resolve; }); });
        panel.saveButton.focus();
        panel.saveButton.dispatchEvent(new Event("click"));
        await reachedSave;
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saving...");
        expect(panel.saveDetails.hidden).toBe(false);
        expect(panel.saveDetails.textContent).toContain("Previous save failed");
        expect(panel.saveAnnouncement.textContent).toBe(announcement);
        const retrying = panel.saving();
        release();
        expect(await retrying).toBe(true);
        await panel.settle();
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
        expect(panel.saveDetails.hidden).toBe(true);
        expect(panel.saveAnnouncement.textContent).toBe("Your changes are saved.");
        expect(panel.activeElement).toBe(panel.saveButton);
        expect((await library.read(panel.state.note.id)).body).toBe(panel.textarea.value);
        await panel.openNote(other.id);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
        expect(panel.saveAnnouncement.textContent).toBe("");
    });

    test("clearing a failed new draft never announces a successful save", async () => {
        const panel = await openClient();
        await panel.compose();
        panel.interceptSave(() => new Response(JSON.stringify({
            error: { code: "io_error", message: "Synthetic draft failure" },
        }), { status: 500 }));
        panel.textarea.value = "# Draft\nUnsaved content";
        panel.textarea.dispatchEvent(new Event("input"));
        expect(await panel.save()).toBe(false);
        expect(panel.saveAnnouncement.textContent).toContain("Save failed");
        panel.textarea.value = "# ";
        panel.textarea.dispatchEvent(new Event("input"));
        expect(panel.saveButton.getAttribute("aria-label")).toBe("New note - not saved yet");
        expect(panel.saveAnnouncement.textContent).toBe("");
        expect((await library.list()).notes).toHaveLength(0);
    });

    test.each([false, true])("typing during a save never claims newer text is Saved (new draft: %s)", async draft => {
        const panel = await openClient();
        if (draft) await panel.compose();
        else {
            const note = await library.create({ body: "# Status\noriginal" }, context);
            await panel.openNote(note.id);
        }
        panel.textarea.value = "# Status\nfirst edit";
        panel.textarea.dispatchEvent(new Event("input"));
        let release, started;
        const reachedSave = new Promise(resolve => { started = resolve; });
        panel.interceptSave(() => { started(); return new Promise(resolve => { release = resolve; }); });
        const saving = panel.save();
        await reachedSave;
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saving...");
        panel.textarea.value += "\nnewer edit";
        panel.textarea.dispatchEvent(new Event("input"));
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saving...");
        release();
        expect(await saving).toBe(true);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Unsaved changes");
        expect((await library.read(panel.state.note.id)).body).toBe("# Status\nfirst edit");
        panel.interceptSave(undefined);
        expect(await panel.save()).toBe(true);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
        expect((await library.read(panel.state.note.id)).body).toBe(panel.textarea.value);
    });

    test("a fidelity guard still allows saving; conflict uses its own resolution instead of Retry", async () => {
        const note = await library.create({ body: "# Status\noriginal" }, context);
        const panel = await openClient();
        await panel.openNote(note.id);
        expect(panel.isPlain()).toBe(true);
        panel.textarea.value += "\nMarkdown edit";
        expect(await panel.save()).toBe(true);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
        await library.update(note.id, { body: "# Status\nexternal", expectedVersion: panel.state.note.version }, context);
        panel.textarea.value += "\nLocal edit";
        expect(await panel.save()).toBe(false);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Save paused - conflict");
        const count = panel.calls.filter(call => call.path === "api/note/update").length;
        panel.saveButton.dispatchEvent(new Event("click"));
        expect(panel.saveDetails.textContent).toContain("Reload or Keep Mine");
        expect(panel.calls.filter(call => call.path === "api/note/update")).toHaveLength(count);
        await panel.resolveConflict(false);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
    });

    test("rich-editor errors persist without a network Retry and clear only when the editor recovers", async () => {
        const note = await library.create({ body: "# Status\noriginal" }, context);
        const panel = await openClient({ richSafe: true });
        await panel.openNote(note.id);
        panel.richError("Cannot serialize this edit");
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Save paused - editor error");
        expect(panel.saveDetails.hidden).toBe(false);
        expect(panel.saveDetails.textContent).toContain("Cannot serialize this edit");
        expect(await panel.save()).toBe(false);
        panel.saveButton.dispatchEvent(new Event("click"));
        expect(panel.calls.filter(call => call.path === "api/note/update")).toHaveLength(0);
        panel.richChange("# Status\nrecovered edit");
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Unsaved changes");
        expect(await panel.save()).toBe(true);
        expect(panel.saveButton.getAttribute("aria-label")).toBe("Saved");
    });
});

describe("first-use discoverability", () => {
    const text = element => element.children.map(child => child instanceof Element ? text(child) : child).join(" ");

    test("empty library and folder offer creation without listbox semantics; drafts restore options", async () => {
        const panel = await openClient();
        expect(text(panel.rows)).toContain("Capture your first thought");
        expect(panel.rows.hasAttribute("role")).toBe(false);
        expect(panel.rows.hasAttribute("aria-label")).toBe(false);
        expect(panel.rows.getAttribute("tabindex")).toBe("-1");
        expect(panel.listCount.textContent).toBe("0 notes");
        await library.create({ body: "# Elsewhere", folder: "Filled" }, context);
        await mkdir(join(root, "Empty"));
        await panel.select({ folder: "Empty" });
        expect(text(panel.rows)).toContain("No notes in this folder");
        expect(panel.rows.hasAttribute("role")).toBe(false);
        panel.rows.querySelector("button").dispatchEvent(new Event("click"));
        await panel.settle();
        expect(panel.state.draft.folder).toBe("Empty");
        expect(panel.rows.getAttribute("role")).toBe("listbox");
        expect(panel.rows.querySelector(".row").getAttribute("role")).toBe("option");
    });

    test("no results offers search guidance, retains count, and removes stale option focus", async () => {
        await library.create({ body: "# Existing" }, context);
        const panel = await openClient();
        panel.rows.querySelector(".row").focus();
        panel.state.query = "missing";
        panel.state.notes = [];
        panel.renderList();
        expect(text(panel.rows)).toContain("Try a different search.");
        expect(panel.rows.querySelector("button")).toBeNull();
        expect(panel.rows.hasAttribute("role")).toBe(false);
        expect(panel.listCount.textContent).toBe("0 results");
        expect(panel.activeElement.getAttribute("type")).toBe("search");
    });

    test("empty smart views explain where their create action saves", async () => {
        const panel = await openClient();
        await panel.select({ view: "session" });
        expect(text(panel.rows)).toContain("No notes in this session");
        expect(text(panel.rows)).toContain("New notes are saved in Notes.");
        panel.rows.querySelector("button").dispatchEvent(new Event("click"));
        await panel.settle();
        expect(panel.state.draft.folder).toBe("");
    });

    test("formatting help is optional, rich-only, and restores focus on close", async () => {
        const note = await library.create({ body: "# Help" }, context);
        const panel = await openClient({ richSafe: true });
        expect(panel.formattingHelp.hidden).toBe(true);
        await panel.openNote(note.id);
        expect(panel.formattingHelp.hidden).toBe(false);
        const help = panel.formattingHelp.querySelector("button");
        help.focus();
        help.dispatchEvent(new Event("click"));
        const dialog = panel.document.body.querySelector("dialog");
        expect(dialog.hasAttribute("open")).toBe(true);
        expect(text(dialog)).toContain("Ctrl / Command + K");
        expect(text(dialog)).toContain("start a bullet, then type [ ]");
        dialog.querySelector("button").dispatchEvent(new Event("click"));
        expect(panel.document.body.querySelector("dialog")).toBeNull();
        expect(panel.activeElement).toBe(help);
        panel.toggleMarkdown();
        expect(panel.formattingHelp.hidden).toBe(true);
    });
});

describe("medium drawer focus", () => {
    test("closed drawer is inert; open drawer traps Tab and every close path restores its opener", async () => {
        const panel = await openClient();
        const buttons = panel.sidebar.querySelectorAll("button");
        const first = buttons[0];
        const last = buttons.at(-1);
        expect(panel.sidebar.inert).toBe(true);
        expect(panel.listPane.inert).toBe(false);
        expect(panel.editorPane.inert).toBe(false);
        first.focus();
        expect(panel.activeElement).not.toBe(first);

        panel.setOverlay(true);
        expect(panel.overlayOpen).toBe(true);
        expect(panel.sidebar.inert).toBe(false);
        expect(panel.listPane.inert).toBe(true);
        expect(panel.editorPane.inert).toBe(true);

        first.focus();
        const shiftTab = Object.assign(new Event("keydown", { cancelable: true }), { key: "Tab", shiftKey: true });
        panel.sidebar.dispatchEvent(shiftTab);
        expect(shiftTab.defaultPrevented).toBe(true);
        expect(panel.activeElement).toBe(last);
        const tab = Object.assign(new Event("keydown", { cancelable: true }), { key: "Tab", shiftKey: false });
        panel.sidebar.dispatchEvent(tab);
        expect(tab.defaultPrevented).toBe(true);
        expect(panel.activeElement).toBe(first);

        const closePaths = [
            () => panel.backdrop.dispatchEvent(new Event("click")),
            () => panel.sidebar.querySelector("button").dispatchEvent(new Event("click")),
            () => panel.document.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" })),
        ];
        for (const close of closePaths) {
            panel.setOverlay(true);
            close();
            expect(panel.overlayOpen).toBe(false);
            expect(panel.activeElement).toBe(panel.sidebarToggle);
            expect(panel.sidebar.inert).toBe(true);
            expect(panel.listPane.inert).toBe(false);
            expect(panel.editorPane.inert).toBe(false);
        }
    });

    test("breakpoint changes clear inertness and move focus to the visible navigation control", async () => {
        const panel = await openClient();
        panel.setOverlay(true);
        await panel.setViewport({ wide: true, narrow: false });
        expect(panel.overlayOpen).toBe(false);
        expect(panel.sidebar.inert).toBe(false);
        expect(panel.listPane.inert).toBe(false);
        expect(panel.editorPane.inert).toBe(false);
        expect(panel.activeElement).toBe(panel.sidebarToggle);

        await panel.setViewport({ wide: false, narrow: false });
        expect(panel.sidebar.inert).toBe(true);
        panel.setOverlay(true);
        await panel.setViewport({ wide: false, narrow: true });
        expect(panel.overlayOpen).toBe(false);
        expect(panel.sidebar.inert).toBe(false);
        expect(panel.listPane.inert).toBe(false);
        expect(panel.editorPane.inert).toBe(false);
        expect(panel.activeElement).toBe(panel.showFoldersButton);
        expect(panel.app.dataset.pane).toBe("list");

        await panel.setViewport({ wide: false, narrow: false });
        expect(panel.sidebar.inert).toBe(true);
        expect(panel.activeElement).toBe(panel.sidebarToggle);

        await panel.setViewport({ wide: false, narrow: true });
        expect(panel.activeElement).toBe(panel.showFoldersButton);
        panel.showFoldersButton.dispatchEvent(new Event("click"));
        const selected = panel.sidebar.querySelector("[aria-current='true']");
        selected.focus();
        await panel.setViewport({ wide: false, narrow: false });
        expect(panel.activeElement).toBe(panel.sidebarToggle);
        panel.rememberFocus(panel.sidebarToggle);
        panel.document.activeElement = panel.document.body;
        await panel.setViewport({ wide: false, narrow: true });
        expect(panel.activeElement).toBe(selected);
        expect(panel.app.dataset.pane).toBe("folders");
    });

    test("returning to folders focuses a visible control when no folder is selected", async () => {
        const panel = await openClient();
        await panel.setViewport({ wide: false, narrow: true });
        panel.showFoldersButton.dispatchEvent(new Event("click"));
        const folderControl = panel.sidebar.querySelector("[aria-current='true']");
        expect(folderControl).not.toBeNull();
        folderControl.focus();

        await panel.setViewport({ wide: false, narrow: false });
        expect(panel.activeElement).toBe(panel.sidebarToggle);
        folderControl.attributes.delete("aria-current");
        panel.rememberFocus(panel.sidebarToggle);
        panel.document.activeElement = panel.document.body;
        await panel.setViewport({ wide: false, narrow: true });

        expect(panel.activeElement).toBe(folderControl);
    });

    test("Escape closes a drawer-opened native dialog before closing the drawer", async () => {
        const panel = await openClient();
        panel.setOverlay(true);
        const newFolder = panel.sidebar.querySelectorAll("button").at(-1);
        newFolder.focus();
        newFolder.dispatchEvent(new Event("click"));
        const dialog = panel.document.body.querySelector("dialog");
        const input = dialog.querySelector("input");
        expect(dialog.hasAttribute("open")).toBe(true);
        expect(panel.activeElement).toBe(input);

        panel.closeOverlayOnEscape(input);
        expect(panel.overlayOpen).toBe(true);
        dialog.close();
        await Promise.resolve();
        expect(panel.activeElement).toBe(newFolder);
        expect(panel.overlayOpen).toBe(true);

        panel.closeOverlayOnEscape(newFolder);
        expect(panel.overlayOpen).toBe(false);
        expect(panel.activeElement).toBe(panel.sidebarToggle);
    });

    test("canceling a drawer dialog after resize restores the visible narrow control", async () => {
        const panel = await openClient();
        panel.setOverlay(true);
        const newFolder = panel.sidebar.querySelectorAll("button").at(-1);
        newFolder.focus();
        newFolder.dispatchEvent(new Event("click"));
        const dialog = panel.document.body.querySelector("dialog");

        await panel.setViewport({ wide: false, narrow: true });
        panel.sidebar.hidden = true;
        dialog.close();
        await Promise.resolve();

        expect(panel.activeElement).toBe(panel.showFoldersButton);
    });

    test("canceling a sidebar dialog after wide-to-medium resize restores the toggle", async () => {
        const panel = await openClient();
        await panel.setViewport({ wide: true, narrow: false });
        const newFolder = panel.sidebar.querySelectorAll("button").at(-1);
        newFolder.focus();
        newFolder.dispatchEvent(new Event("click"));
        const dialog = panel.document.body.querySelector("dialog");

        await panel.setViewport({ wide: false, narrow: false });
        expect(panel.sidebar.inert).toBe(true);
        dialog.close();
        await Promise.resolve();

        expect(panel.activeElement).toBe(panel.sidebarToggle);
    });
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
        property(panel, "project").focus();
        panel.toggleMarkdown();
        expect(panel.frontmatterView.nextSibling).toBe(panel.textarea);
        expect(panel.activeElement).toBe(property(panel, "project"));
        // Returning to rich view, or reloading after an external change, rebuilds the editor and its slot.
        panel.frontmatterMore.focus();
        panel.toggleMarkdown();
        expect(panel.activeElement).toBe(panel.frontmatterMore);
        const rebuilt = panel.richHeader();
        expect(rebuilt).not.toBe(slot);
        expect(panel.frontmatterView.parentNode).toBe(rebuilt);
        expect(slot.children).toEqual([]);
        await library.update(note.id, { body: "# Placement\nexternal", expectedVersion: note.version }, context);
        await panel.refresh();
        expect(panel.richHeader()).not.toBe(rebuilt);
        expect(panel.frontmatterView.parentNode).toBe(panel.richHeader());
    });

    test("a background refresh preserves pending navigation scroll when it supersedes a folder selection", async () => {
        await library.create({ body: "# Folder note", folder: "Folder" }, context);
        const panel = await openClient();
        let release, started;
        const waiting = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        panel.delayNotes(async () => {
            panel.delayNotes(null);
            started();
            await gate;
        });
        const before = panel.scrollCalls();
        const selection = panel.select({ folder: "Folder" });
        await waiting;
        try {
            await panel.refresh();
            expect(panel.state.notes).toHaveLength(1);
            expect(panel.state.notes[0].folder).toBe("Folder");
            expect(panel.scrollCalls()).toBe(before + 1);
        } finally {
            release();
        }
        await selection;
        expect(panel.scrollCalls()).toBe(before + 1);
        await panel.refresh();
        expect(panel.scrollCalls()).toBe(before + 1);
    });

    test("background refresh preserves list scroll while explicit note navigation still scrolls", async () => {
        const note = await library.create({ body: "# Scroll\noriginal" }, context);
        const other = await library.create({ body: "# Other\nsecond" }, context);
        const panel = await openClient();
        await panel.openNote(note.id);
        panel.rows.scrollTop = 120;
        const before = panel.scrollCalls();
        await library.update(note.id, { body: "# Scroll\nexternal", expectedVersion: note.version }, context);
        panel.rows.contains = () => true;
        await panel.refresh();
        expect(panel.rows.scrollTop).toBe(120);
        expect(panel.scrollCalls()).toBe(before);
        expect(panel.rows.querySelectorAll(".row").find(row => row.getAttribute("aria-selected") === "true").lastFocusOptions)
            .toMatchObject({ preventScroll: true });
        panel.rows.contains = () => false;
        await panel.openNote(other.id);
        expect(panel.scrollCalls()).toBe(before + 1);
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

describe("lazy rich editor", () => {
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const gate = () => {
        let open, fail;
        const promise = new Promise((resolve, reject) => { open = resolve; fail = reject; });
        return { promise, open, fail };
    };
    // Records each rich editor the client creates, and where it was asked to focus.
    const tracked = (created, focused) => module => ({
        createRichEditor: options => {
            const result = module.createRichEditor(options);
            created.push(options.body);
            result.editor.commands = { focus: at => focused.push(at) };
            return result;
        },
    });

    test("the editor pane shows a loading state, then the rich editor with any focus asked for meanwhile", async () => {
        const note = await library.create({ body: "# Lazy\nbody" }, context);
        const loaded = gate();
        const created = [];
        const focused = [];
        const panel = await openClient({ richSafe: true, importEditor: module => loaded.promise.then(() => tracked(created, focused)(module)) });
        await panel.openNote(note.id);
        expect(panel.isWaiting()).toBe(true);
        expect(panel.editorLoading.hidden).toBe(false);
        expect(panel.textarea.hidden).toBe(true);
        expect(panel.richElement.hidden).toBe(true);
        expect(panel.markdownButton.disabled).toBe(true);
        panel.toggleMarkdown();
        panel.focusEditor();
        expect(panel.isPlain()).toBe(false);

        loaded.open();
        await tick();
        expect(panel.isWaiting()).toBe(false);
        expect(panel.editorLoading.hidden).toBe(true);
        expect(panel.richElement.hidden).toBe(false);
        expect(panel.textarea.hidden).toBe(true);
        expect(panel.markdownButton.disabled).toBe(false);
        expect(created).toEqual([note.body]);
        expect(focused).toEqual(["end"]);
    });

    test("switching notes while the editor loads builds it only for the note now open", async () => {
        const first = await library.create({ body: "# First\none" }, context);
        const second = await library.create({ body: "# Second\ntwo" }, context);
        const loaded = gate();
        const created = [];
        const panel = await openClient({ richSafe: true, importEditor: module => loaded.promise.then(() => tracked(created, [])(module)) });
        await panel.openNote(first.id);
        await panel.openNote(second.id);
        loaded.open();
        await tick();
        expect(created).toEqual([second.body]);
        expect(panel.richElement.hidden).toBe(false);
    });

    test("a failed load falls back to Markdown with a toast, and the next rich toggle retries", async () => {
        const note = await library.create({ body: "# Offline\nbody" }, context);
        let failing = true;
        const focused = [];
        const panel = await openClient({
            richSafe: true,
            importEditor: module => failing ? Promise.reject(new Error("Network down.")) : Promise.resolve(tracked([], focused)(module)),
        });
        await panel.openNote(note.id);
        await tick();
        expect(panel.isWaiting()).toBe(false);
        expect(panel.isPlain()).toBe(true);
        expect(panel.textarea.hidden).toBe(false);
        expect(panel.textarea.value).toBe(note.body);
        expect(panel.toast.hidden).toBe(false);
        // The rejection comes from the test realm, so the client formats it as a foreign Error.
        expect(panel.toast.textContent).toStartWith("Rich editing is unavailable. Your Markdown is unchanged.");
        expect(panel.toast.textContent).toContain("Network down.");

        failing = false;
        panel.toggleMarkdown();
        await tick();
        expect(panel.isPlain()).toBe(false);
        expect(panel.richElement.hidden).toBe(false);
        expect(panel.textarea.value).toBe(note.body);
        expect(focused).toEqual(["end"]);
    });

    test("recovered text autosaves while the editor is still loading", async () => {
        const recovery = { noteId: null, folder: "", body: "# Recovered\nwhile loading" };
        await pushRecovery(recoveryPath(statePath), recovery);
        const panel = await openClient({ richSafe: true, importEditor: () => new Promise(() => {}), startupToast: true });
        expect(panel.toast.textContent).toBe("Recovered unsaved text from when Notes last closed.");
        expect(panel.isWaiting()).toBe(true);
        expect(panel.textarea.value).toBe(recovery.body);
        expect(await panel.save()).toBe(true);
        const [saved] = (await library.list()).notes;
        expect((await library.read(saved.id)).body).toBe(recovery.body);
    });

    test("recovered text survives a folder request that fails, even if the panel reloads before retrying", async () => {
        const note = await library.create({ body: "# Kept\nsaved" }, context);
        const recovery = { noteId: note.id, folder: "", body: "# Kept\nunsaved" };
        await pushRecovery(recoveryPath(statePath), recovery);
        let failed = false;
        const panel = await openClient({
            respond: path => path === "api/folders" && !failed && (failed = true)
                ? new Response(JSON.stringify({ error: { code: "io_error", message: "Folders failed." } }), { status: 500 })
                : undefined,
        });
        await panel.settle();
        expect(failed).toBe(true);
        // The list keeps the error with a retry, and nothing was claimed, so closing cannot lose the text.
        expect(panel.listStatus().error).toBe("Folders failed.");
        expect(panel.rows.querySelectorAll(".list-error")).toHaveLength(1);
        expect(panel.calls.some(call => call.path === "api/startup" || call.path === "api/note/rescue")).toBe(false);
        expect(panel.eventSources()).toBe(0);

        const reloaded = await openClient();
        expect(reloaded.listStatus()).toBe("ready");
        expect(reloaded.textarea.value).toBe(recovery.body);
        expect(reloaded.state.conflict).toBe(true);
        expect(reloaded.state.recovered).toBe(true);
    });

    test("a retry finishes startup with the recovered text", async () => {
        const recovery = { noteId: null, folder: "", body: "# Recovered\nafter folders" };
        await pushRecovery(recoveryPath(statePath), recovery);
        let failed = false;
        const panel = await openClient({
            respond: path => path === "api/folders" && !failed && (failed = true)
                ? new Response(JSON.stringify({ error: { code: "io_error", message: "Folders failed." } }), { status: 500 })
                : undefined,
        });
        await panel.settle();
        await panel.listStatus().retry();
        expect(panel.listStatus()).toBe("ready");
        expect(panel.textarea.value).toBe(recovery.body);
        expect(panel.state.draft).not.toBeNull();
        expect(panel.eventSources()).toBe(1);
    });
});

describe("startup while the library is unavailable", () => {
    test("a stalled library shows a retryable error and keeps the restored note until it loads", async () => {
        const note = await library.create({ body: "# Restored\ntext" }, context);
        await saveUiState(statePath, { sidebar: true, selection: { view: "all" }, noteId: note.id, collapsed: [] });
        let release;
        const loading = new Promise(resolve => { release = resolve; });
        await server.close();
        server = await startServer({ getLibrary: () => loading, libraryWaitMs: 30 });
        const panel = await openClient();
        const failed = panel.listStatus();
        expect(failed.error).toBe("Notes is still loading the library. Try again in a moment.");
        expect(panel.rows.querySelectorAll(".list-error")).toHaveLength(1);
        expect(panel.state.note).toBeNull();
        expect(panel.state.ui.noteId).toBe(note.id);

        release(library);
        const retrying = failed.retry();
        expect(panel.listStatus()).toBe("loading");
        await retrying;
        await panel.settle();
        expect(panel.listStatus()).toBe("ready");
        expect(panel.state.notes.map(item => item.title)).toEqual(["Restored"]);
        expect(panel.state.note.id).toBe(note.id);
        expect(panel.textarea.value).toBe(note.body);
    });

    test("a failed startup state request retries without having consumed recovered text", async () => {
        const recovery = { noteId: null, folder: "", body: "# Recovered\nafter retry" };
        await pushRecovery(recoveryPath(statePath), recovery);
        let failed = false;
        const panel = await openClient({
            respond: path => path === "api/state" && !failed && (failed = true)
                ? new Response(JSON.stringify({ error: { code: "io_error", message: "State unavailable." } }), { status: 500 })
                : undefined,
        });
        expect(panel.listStatus().error).toBe("State unavailable.");
        expect(panel.rows.querySelectorAll(".list-error")).toHaveLength(1);

        await panel.listStatus().retry();
        expect(panel.listStatus()).toBe("ready");
        expect(panel.textarea.value).toBe(recovery.body);
        expect(panel.toast.textContent).toBe("Recovered unsaved text from when Notes last closed.");
    });

    test("recovered text survives the user moving on while the server cannot take it back", async () => {
        const note = await library.create({ body: "# Moved\nsaved" }, context);
        const recovery = { noteId: note.id, folder: "", body: "# Moved\nunsaved" };
        await pushRecovery(recoveryPath(statePath), recovery);
        let moved = false;
        let stashes = 0;
        let releaseStash;
        const panel = await openClient({
            respond: (path, client) => {
                // The user composes a new note while the recovered note is still loading.
                if (path.startsWith("api/note?") && !moved && (moved = true)) {
                    return client.compose().then(() => fetch(new URL(path, server.url), { headers: { Origin: new URL(server.url).origin } }));
                }
                if (path !== "api/note/rescue") return;
                stashes += 1;
                if (stashes === 1) return new Response(JSON.stringify({ error: { code: "io_error", message: "Disk full." } }), { status: 500 });
                // The retry stalls, then fails, as the panel closes.
                if (stashes === 2) return new Promise(resolve => { releaseStash = resolve; })
                    .then(() => new Response(JSON.stringify({ error: { code: "offline", message: "Closed." } }), { status: 503 }));
            },
            startupToast: true,
        });
        await panel.settle();
        expect(panel.state.draft).not.toBeNull();
        expect(panel.state.recovered).toBe(false);
        expect(panel.toast.textContent).toBe("Notes could not keep recovered unsaved text yet; it will try again.");

        const refreshing = panel.refresh();
        while (!releaseStash) await Bun.sleep(1);
        const closing = panel.close();
        expect(panel.calls.filter(call => call.path === "api/note/rescue" && call.keepalive)).toEqual([
            expect.objectContaining({ body: { id: note.id, folder: "", body: recovery.body, stash: true, key: expect.stringMatching(/^\d{15}-[0-9a-f]{12}$/) } }),
        ]);
        // Every send of this text names one server entry, so a resend after a stash that landed keeps one copy.
        expect(new Set(panel.calls.filter(call => call.path === "api/note/rescue").map(call => call.body.key)).size).toBe(1);
        releaseStash();
        await Promise.all([refreshing, closing]);
        const reloaded = await openClient();
        expect(reloaded.textarea.value).toBe(recovery.body);
        expect(reloaded.state.recovered).toBe(true);
    });

    test("a restored-note read that failed while loading is read again when a newer list load succeeds", async () => {
        const note = await library.create({ body: "# Restored\nagain" }, context);
        await saveUiState(statePath, { sidebar: true, selection: { view: "all" }, noteId: note.id, collapsed: [] });
        const busy = () => new Response(JSON.stringify({ error: { code: "library_busy", message: "Notes is still loading the library." } }), { status: 503 });
        let noteFailed = false;
        let listsStalled = false;
        const panel = await openClient({
            respond: (path, client) => {
                if (path.startsWith("api/note?") && !noteFailed && (noteFailed = true)) return busy();
                // The first list load stalls and a search or refresh supersedes it.
                if (path.startsWith("api/notes?") && !listsStalled && (listsStalled = true)) {
                    return Bun.sleep(0).then(() => { void client.refresh(); return Bun.sleep(50); }).then(busy);
                }
            },
        });
        await panel.settle();
        expect(panel.listStatus()).toBe("ready");
        expect(panel.state.note.id).toBe(note.id);
        expect(panel.textarea.value).toBe(note.body);
    });

    test("a list load after a failed startup state request finishes startup", async () => {
        const note = await library.create({ body: "# Target\nafter state" }, context);
        await server.close();
        server = await startServer({ target: { noteId: note.id, folder: "" } });
        let failed = false;
        const panel = await openClient({
            respond: path => path === "api/state" && !failed && (failed = true)
                ? new Response(JSON.stringify({ error: { code: "io_error", message: "State unavailable." } }), { status: 500 })
                : undefined,
        });
        expect(panel.listStatus().error).toBe("State unavailable.");

        await panel.refresh();
        await panel.settle();
        expect(panel.listStatus()).toBe("ready");
        expect(panel.state.note.id).toBe(note.id);
        expect(panel.eventSources()).toBe(1);
        expect(panel.calls.filter(call => call.path === "api/startup")).toHaveLength(1);
    });

    test("a restored note the library briefly cannot read is not forgotten, and the next list load opens it", async () => {
        const note = await library.create({ body: "# Busy\ntext" }, context);
        await saveUiState(statePath, { sidebar: true, selection: { view: "all" }, noteId: note.id, collapsed: [] });
        let busy = true;
        const panel = await openClient({
            respond: path => busy && path.startsWith("api/note?")
                ? new Response(JSON.stringify({ error: { code: "library_busy", message: "Notes is still loading the library." } }), { status: 503 })
                : undefined,
            startupToast: true,
        });
        expect(panel.listStatus()).toBe("ready");
        expect(panel.toast.textContent).toBe("Notes is still loading the library.");
        expect(panel.state.ui.noteId).toBe(note.id);

        busy = false;
        await panel.refresh();
        await panel.settle();
        expect(panel.state.note.id).toBe(note.id);
        expect(panel.textarea.value).toBe(note.body);
        expect(panel.calls.filter(call => call.path === "api/startup")).toHaveLength(1);
    });

    test("a startup claim that does not reach the server is claimed again by the next list load", async () => {
        const recovery = { noteId: null, folder: "", body: "# Recovered\nafter claim" };
        await pushRecovery(recoveryPath(statePath), recovery);
        let failed = false;
        const panel = await openClient({
            respond: path => path === "api/startup" && !failed && (failed = true)
                ? new Response(JSON.stringify({ error: { code: "offline", message: "Notes is offline." } }), { status: 503 })
                : undefined,
            startupToast: true,
        });
        await panel.settle();
        expect(panel.listStatus()).toBe("ready");
        expect(panel.toast.textContent).toBe("Notes is offline.");
        expect(panel.state.draft).toBeNull();
        expect(panel.eventSources()).toBe(1);

        await panel.refresh();
        await panel.settle();
        expect(panel.textarea.value).toBe(recovery.body);
        expect(panel.state.draft).not.toBeNull();
        expect(panel.calls.filter(call => call.path === "api/startup")).toHaveLength(2);
    });

    test("recovered text for a note that cannot be read is kept, not saved as a copy", async () => {
        const note = await library.create({ body: "# Unreadable\nsaved" }, context);
        const recovery = { noteId: note.id, folder: "", body: "# Unreadable\nunsaved" };
        await pushRecovery(recoveryPath(statePath), recovery);
        const panel = await openClient({
            respond: path => path.startsWith("api/note?")
                ? new Response(JSON.stringify({ error: { code: "io_error", message: "The note could not be read." } }), { status: 500 })
                : undefined,
            startupToast: true,
        });
        await panel.settle();
        expect(panel.state.draft).toBeNull();
        expect(panel.toast.textContent).toBe("The note could not be read.");
        expect((await library.list()).notes).toHaveLength(1);

        const reloaded = await openClient();
        expect(reloaded.textarea.value).toBe(recovery.body);
        expect(reloaded.state.recovered).toBe(true);
    });

    test("an open target waits for the lists, and any later successful load finishes startup once", async () => {
        const note = await library.create({ body: "# Target\ntext" }, context);
        await server.close();
        server = await startServer({ target: { noteId: note.id, folder: "" } });
        let failed = false;
        const panel = await openClient({
            respond: path => path.startsWith("api/notes?") && !failed && (failed = true)
                ? new Response(JSON.stringify({ error: { code: "library_busy", message: "Notes is still loading the library." } }), { status: 503 })
                : undefined,
        });
        expect(panel.listStatus().error).toBe("Notes is still loading the library.");
        expect(panel.eventSources()).toBe(0);

        // Not only the retry button: a refresh, search or reveal that loads the lists also finishes startup.
        await panel.refresh();
        await panel.settle();
        expect(panel.listStatus()).toBe("ready");
        expect(panel.state.note.id).toBe(note.id);
        expect(panel.eventSources()).toBe(1);
        await panel.refresh();
        await panel.settle();
        expect(panel.eventSources()).toBe(1);
        expect(panel.calls.filter(call => call.path === "api/startup")).toHaveLength(1);
    });

    test("recovered text the library cannot read and the server cannot keep stays in the editor", async () => {
        const note = await library.create({ body: "# Busy\nsaved" }, context);
        const recovery = { noteId: note.id, folder: "", body: "# Busy\nunsaved" };
        await pushRecovery(recoveryPath(statePath), recovery);
        const panel = await openClient({
            respond: path => path.startsWith("api/note?")
                ? new Response(JSON.stringify({ error: { code: "library_busy", message: "Notes is still loading the library." } }), { status: 503 })
                : path === "api/note/rescue"
                    ? new Response(JSON.stringify({ error: { code: "io_error", message: "Disk full." } }), { status: 500 })
                    : undefined,
            startupToast: true,
        });
        expect(panel.textarea.value).toBe(recovery.body);
        expect(panel.state.draft).not.toBeNull();
    });

    test("closing while recovered text is being handed back sends it again", async () => {
        const note = await library.create({ body: "# Closing\nsaved" }, context);
        const recovery = { noteId: note.id, folder: "", body: "# Closing\nunsaved" };
        await pushRecovery(recoveryPath(statePath), recovery);
        let closed = false;
        const panel = await openClient({
            respond: (path, client, window) => {
                if (path.startsWith("api/note?")) {
                    return new Response(JSON.stringify({ error: { code: "library_busy", message: "Notes is still loading the library." } }), { status: 503 });
                }
                // The panel closes while the stash is in flight, cancelling it.
                if (path === "api/note/rescue" && !closed && (closed = true)) {
                    window.dispatchEvent(new Event("pagehide"));
                    return new Response(JSON.stringify({ error: { code: "offline", message: "Closed." } }), { status: 503 });
                }
            },
            startupToast: true,
        });
        expect(panel.calls.filter(call => call.path === "api/note/rescue" && call.keepalive)).toEqual([
            expect.objectContaining({ body: { id: note.id, folder: "", body: recovery.body, stash: true, key: expect.stringMatching(/^\d{15}-[0-9a-f]{12}$/) } }),
        ]);
        expect(new Set(panel.calls.filter(call => call.path === "api/note/rescue").map(call => call.body.key)).size).toBe(1);
    });
});
