// Notes panel client. Served same-origin by server.mjs; every request goes to the capability-scoped API.
import { GUARD_MESSAGE, safeExternal } from "./common";
import type { Editor } from "@tiptap/core";
declare const __ICONS__: Record<string, { width: number; path: string }>;
type EditorModule = typeof import("./editor");
// Tiptap is a separate bundle so the list can paint before it downloads and evaluates. The client tests replace this line.
const importEditor = (): Promise<EditorModule> => import("./editor.js");

type Warning = { code: string; message: string };
type Summary = {
    id: string | null; path: string; title: string; folder: string; lastEdited: string;
    project: string | null; created_by: string | null; pinned: boolean; version: string;
    snippet?: string; warning?: Warning;
};
type Note = Summary & { body: string };
type FolderNode = { path: string; name: string; count: number; version?: string | null; warning?: Warning; children: FolderNode[] };
type Selection = { view: "all" | "project" | "session" } | { folder: string };
type UiState = { sidebar: boolean; selection: Selection; noteId: string | null; collapsed: string[] };
type Target = { view?: "all" | "project" | "session"; folder?: string; noteId?: string };
type Recovery = { noteId: string | null; folder: string; body: string };
type MenuItem = { label: string; icon?: string; action: () => void; disabled?: boolean; destructive?: boolean } | "-";
type Child = Node | string | null | undefined | false;

class ApiError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

const NOTE_KEY = "application/x-copilot-note";
const wide = matchMedia("(min-width: 960px)");
const narrow = matchMedia("(max-width: 639.98px)");

const state = {
    context: { sessionId: null as string | null, project: null as string | null, sessionName: null as string | null },
    ui: { sidebar: true, selection: { view: "all" }, noteId: null, collapsed: [] } as UiState,
    folders: null as FolderNode | null,
    notes: [] as Summary[],
    query: "",
    note: null as Note | null,
    draft: null as { folder: string; key: string } | null,
    sent: "",
    conflict: false,
    recovered: false,
};
let pane: "folders" | "list" | "note" = "list";
let overlay = false;
let overlayOpener: HTMLElement | null = null;
type Viewport = "wide" | "medium" | "narrow";
const viewport = (): Viewport => wide.matches ? "wide" : narrow.matches ? "narrow" : "medium";
let viewportMode = viewport();
let lastFocused: HTMLElement | null = null;

// A panel the app opened without a session has no session notes, and no project either.
function viewAvailable(view: "all" | "project" | "session") {
    return view === "all" || !!(view === "project" ? state.context.project : state.context.sessionId);
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (name.startsWith("on") && typeof value === "function") element.addEventListener(name.slice(2), value as EventListener);
        else element.setAttribute(name, value === true ? "" : String(value));
    }
    element.append(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
    return element;
}

function icon(name: string) {
    const data = __ICONS__[name];
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${data.width} 16`);
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("icon");
    svg.innerHTML = data.path;
    return svg;
}

const iconButton = (name: string, label: string, onclick: (event: MouseEvent) => void, props: Record<string, unknown> = {}) =>
    h("button", { type: "button", class: "icon-button", "aria-label": label, title: label, onclick, ...props }, icon(name));

async function request<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, body === undefined ? {} : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
    } catch {
        throw new ApiError("offline", "Notes is not responding. Reopen the panel if this continues.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(data.error?.code ?? "io_error", data.error?.message ?? `Request failed (${response.status}).`);
    return data as T;
}

// Startup milestones for `bun run bench:notes`; "-painted" lands after the next frame.
const marked = new Set<string>();
function markOnce(name: string) {
    if (marked.has(name) || typeof performance === "undefined") return;
    marked.add(name);
    performance.mark(`notes:${name}`);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(() => performance.mark(`notes:${name}-painted`)));
}

const keyOf = (note: { id: string | null; path: string }) => note.id ?? note.path;
const openKey = () => (state.note ? keyOf(state.note) : null);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const inside = (path: string, folder: string) => folder === "" || path === folder || path.startsWith(`${folder}/`);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const titleFromText = (text: string) => text.split("\n").find(line => line.trim())?.replace(/^\s*#+\s*/, "").trim() || "New Note";

// ---------- Layout ----------

const app = document.getElementById("app")!;
const sidebar = h("aside", { class: "sidebar", "aria-label": "Folders" });
const smart = h("nav", { class: "smart", "aria-label": "Smart folders" });
const tree = h("div", { class: "tree", role: "group", "aria-label": "Folders" });
const listTitle = h("h1", { class: "list-title" });
const listCount = h("p", { class: "list-count", "aria-live": "polite" });
const search = h("input", { type: "search", class: "search-input", placeholder: "Search all notes", "aria-label": "Search all notes", spellcheck: "false", autocomplete: "off" });
const rows = h("div", { class: "rows", role: "listbox", "aria-label": "Notes", tabindex: "0" });
const dateLine = h("p", { class: "date-line" });
const banner = h("div", { class: "banner", role: "status", hidden: true });
const fidelityBanner = h("div", { class: "banner", role: "status", hidden: true });
const textarea = h("textarea", { class: "note-text", "aria-label": "Note", spellcheck: "true", hidden: true });
const richElement = h("div", { class: "rich-note", hidden: true });
const editorLoading = h("div", { class: "editor-loading", role: "status", hidden: true }, "Loading editor…");
let rich: Editor | null = null;
let plain = false;
let guarded = false;
let editorError = false;
let editorModule: EditorModule | null = null;
let editorLoad: Promise<EditorModule> | null = null;
// While the editor bundle loads, the pane shows a placeholder; the token drops loads the user has navigated away from.
let editorWaiting = false;
let editorFocus = false;
let editorToken = 0;
let editorErrorText = "";
let saveFailure: string | null = null;
let saveDetailsOpen = false;
let lastSaveAttention = "";
const saveDetails = h("div", { id: "save-details", class: "save-details", hidden: true });
const saveAnnouncement = h("span", { class: "save-announcement", role: "status", "aria-live": "polite", "aria-atomic": "true" });
const saveSeparator = h("span", { class: "toolbar-separator", "aria-hidden": "true", hidden: true });
const saveButton = iconButton("check", "Saved", () => {
    if (saveFailure && !inflight && !state.conflict && !editorError) void save();
    else {
        saveDetailsOpen = !saveDetailsOpen;
        renderSaveStatus();
    }
}, { class: "icon-button save-button", "aria-controls": "save-details", "aria-expanded": "false", hidden: true });
const markdownButton = iconButton("code", "View as Markdown", () => toggleMarkdown());
const copilotButton = iconButton("copilot", "Ask Copilot about this note", () => {
    if (!askPanel.hidden) return hideAsk();
    askPanel.hidden = false;
    copilotButton.setAttribute("aria-expanded", "true");
    askInput.focus();
}, { "aria-expanded": "false", "aria-controls": "ask-note" });
const askInput = h("input", { type: "text", class: "text-input", "aria-label": "Ask Copilot about this note", placeholder: "Ask about this note", maxlength: "16000" });
// Stays visible below the toolbar after the prompt hides, without crowding the action buttons.
const askStatus = h("span", { role: "status", class: "ask-status" });
const askPanel = h("div", { id: "ask-note", class: "ask-note", hidden: true }, askInput);
const emptyEditor = h("div", { class: "empty-editor" }, icon("note"), h("p", {}, "No note selected"));
const formattingHelp = h("footer", { class: "editor-help", hidden: true },
    h("button", { type: "button", class: "text-button", onclick: () => void showFormattingHelp() }, "Formatting help"));
const pinButton = iconButton("pin", "Pin note", () => state.note && void togglePin(state.note));
const moveButton = iconButton("file-moved", "Move note to folder", () => state.note && void moveDialog(state.note));
const trashButton = iconButton("trash", "Delete note", () => state.note && void deleteNote(state.note));
const sidebarToggle = iconButton("sidebar-collapse", "Hide folders", toggleSidebar, { class: "icon-button hide-narrow" });
const toast = h("div", { class: "toast", role: "alert", hidden: true });
const showFoldersButton = iconButton("chevron-left", "Show folders", () => setPane("folders"), { class: "icon-button narrow-only" });
const backToNotesButton = iconButton("chevron-left", "Back to notes", () => void backToList(), { class: "icon-button narrow-only" });

sidebar.append(
    h("header", { class: "pane-header" }, h("h2", { class: "sidebar-title" }, "Folders"),
        iconButton("x", "Close folders", () => setOverlay(false), { class: "icon-button medium-only" })),
    h("div", { class: "sidebar-scroll" }, smart, tree),
    h("footer", { class: "sidebar-footer" },
        h("button", { type: "button", class: "text-button", onclick: () => void newFolder("") }, icon("plus"), "New Folder")),
);
const listPane = h("section", { class: "list-pane", "aria-label": "Note list" },
    h("header", { class: "pane-header" },
        showFoldersButton,
        sidebarToggle,
        h("div", { class: "list-heading" }, listTitle, listCount),
        iconButton("compose", "New note", () => void compose())),
    h("div", { class: "search" }, icon("search"), search),
    rows,
);
const editorPane = h("main", { class: "editor-pane", "aria-label": "Editor" },
    h("header", { class: "pane-header editor-toolbar" },
        backToNotesButton,
        h("span", { class: "spacer" }), saveButton, saveSeparator, markdownButton, copilotButton, pinButton, moveButton, trashButton),
    h("div", { class: "editor-feedback" }, saveDetails, askStatus, saveAnnouncement),
    askPanel, banner, fidelityBanner,
    h("div", { class: "editor-scroll" }, dateLine, textarea, richElement, editorLoading, emptyEditor),
    formattingHelp,
);
const backdrop = h("div", { class: "backdrop", onclick: () => setOverlay(false) });
app.append(sidebar, backdrop, listPane, editorPane);
document.body.append(toast);

function rememberFocus(target: EventTarget | null) {
    if (target && target !== document.body) lastFocused = target as HTMLElement;
}

function selectedFolderButton() {
    const selected = sidebar.querySelector<HTMLButtonElement>("[aria-current='true']");
    return selected?.getClientRects().length
        ? selected
        : [...sidebar.querySelectorAll<HTMLButtonElement>(".folder-button")]
            .find(button => !button.disabled && !button.hidden && button.getClientRects().length > 0);
}

function focusTargetForViewport() {
    if (viewport() !== "narrow") return sidebarToggle;
    return pane === "folders"
        ? selectedFolderButton()
        : pane === "list" ? showFoldersButton : backToNotesButton;
}

document.addEventListener("focusin", event => rememberFocus(event.target));
document.addEventListener("focusout", event => rememberFocus(event.target));

function layout() {
    app.classList.toggle("sidebar-hidden", !state.ui.sidebar);
    app.classList.toggle("overlay-open", overlay);
    app.dataset.pane = pane;
    const medium = viewport() === "medium";
    sidebar.inert = medium && !overlay;
    listPane.inert = medium && overlay;
    editorPane.inert = medium && overlay;
    const shown = wide.matches && state.ui.sidebar;
    sidebarToggle.replaceChildren(icon(shown ? "sidebar-collapse" : "sidebar-expand"));
    sidebarToggle.setAttribute("aria-label", shown ? "Hide folders" : "Show folders");
    sidebarToggle.title = shown ? "Hide folders" : "Show folders";
    sidebarToggle.setAttribute("aria-expanded", String(wide.matches ? state.ui.sidebar : overlay));
}

function toggleSidebar() {
    if (wide.matches) {
        state.ui.sidebar = !state.ui.sidebar;
        persistUi();
        layout();
    } else {
        setOverlay(!overlay);
    }
}

function setOverlay(open: boolean) {
    if (open === overlay || (open && viewport() !== "medium")) return;
    if (open) overlayOpener = sidebarToggle;
    overlay = open;
    layout();
    if (open) {
        const selected = sidebar.querySelector<HTMLElement>("[aria-current='true']");
        (selected ?? [...sidebar.querySelectorAll<HTMLButtonElement>("button")].find(button => !button.disabled && !button.hidden))?.focus();
    } else {
        overlayOpener?.focus();
        overlayOpener = null;
    }
}

function setPane(next: typeof pane) {
    pane = next;
    layout();
}

function reconcileViewport() {
    const next = viewport();
    if (next === viewportMode) return layout();
    const wasOpen = overlay;
    const active = document.activeElement === document.body ? lastFocused : document.activeElement;
    const focusedSidebar = !!active && sidebar.contains(active);
    const focusedNarrowControl = active === showFoldersButton || active === backToNotesButton;
    const focusedSidebarToggle = active === sidebarToggle;
    viewportMode = next;
    overlay = false;
    layout();
    if (next === "medium" && (wasOpen || focusedSidebar || focusedNarrowControl)) {
        sidebarToggle.focus();
    } else if (next === "wide" && (wasOpen || focusedNarrowControl)) {
        sidebarToggle.focus();
    } else if (next === "narrow" && (wasOpen || focusedSidebar || focusedSidebarToggle)) {
        const target = pane === "folders"
            ? selectedFolderButton()
            : pane === "list" ? showFoldersButton : backToNotesButton;
        target?.focus();
    }
    if (!overlay) overlayOpener = null;
}

wide.addEventListener("change", reconcileViewport);
narrow.addEventListener("change", reconcileViewport);

sidebar.addEventListener("keydown", event => {
    if (viewport() !== "medium" || !overlay) return;
    if (event.key !== "Tab") return;
    const buttons = [...sidebar.querySelectorAll<HTMLButtonElement>("button")].filter(button => !button.disabled && !button.hidden);
    if (!buttons.length) {
        event.preventDefault();
        return;
    }
    const active = document.activeElement;
    if (event.shiftKey && active === buttons[0]) {
        event.preventDefault();
        buttons.at(-1)?.focus();
    } else if (!event.shiftKey && active === buttons.at(-1)) {
        event.preventDefault();
        buttons[0].focus();
    }
});

let toastTimer = 0;
function showToast(text: string) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 6000);
}

// ---------- UI state ----------

let uiTimer = 0;
function persistUi() {
    clearTimeout(uiTimer);
    uiTimer = window.setTimeout(() => {
        request("api/ui", { state: state.ui }).catch(() => { /* preferences are best-effort */ });
    }, 300);
}

function remapFolder(from: string, to: string) {
    const remap = (path: string) => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    if ("folder" in state.ui.selection) state.ui.selection = { folder: remap(state.ui.selection.folder) };
    state.ui.collapsed = state.ui.collapsed.map(remap);
    if (state.draft) state.draft.folder = remap(state.draft.folder);
    persistUi();
}

// ---------- Data ----------

function listParams() {
    const params = new URLSearchParams();
    const selection = state.ui.selection;
    if (state.query.trim()) params.set("query", state.query);
    else if ("view" in selection) params.set("view", selection.view);
    else params.set("folder", selection.folder);
    return params.toString();
}

let listSequence = 0;
let listScrollPending = false;
// Until the first list loads, the list shows loading, or an error with a retry, rather than "No notes".
let listStatus: "loading" | "ready" | { error: string; retry: () => Promise<void> } = "loading";
let latestLists: Promise<boolean> = Promise.resolve(false);
// Resolves whether the lists loaded; a superseded load resolves with the load that replaced it.
function refreshLists(preserveScroll = false, foldersRequest?: Promise<{ folders: FolderNode }>): Promise<boolean> {
    if (!preserveScroll) listScrollPending = true;
    const run = loadLists(preserveScroll, ++listSequence, foldersRequest);
    latestLists = run;
    return run;
}

async function loadLists(preserveScroll: boolean, sequence: number, foldersRequest?: Promise<{ folders: FolderNode }>): Promise<boolean> {
    try {
        const [folders, notes] = await Promise.all([
            foldersRequest ?? request<{ folders: FolderNode }>("api/folders"),
            request<{ notes: Summary[] }>(`api/notes?${listParams()}`),
        ]);
        if (sequence !== listSequence) return latestLists;
        listStatus = "ready";
        state.folders = folders.folders;
        state.notes = notes.notes;
        renderSidebar();
        renderList(!listScrollPending);
        listScrollPending = false;
        markOnce("list");
        // Recovered text a previous load could not hand back is retried now the library answers.
        if (heldRecoveries.size) await retryHeldRecoveries();
        // Startup claims the open target and recovered text only once a list load succeeds, from any caller.
        const resume = resumeStartup;
        resumeStartup = null;
        await resume?.();
        return true;
    } catch (error) {
        if (sequence !== listSequence) return latestLists;
        if (error instanceof ApiError && error.code === "not_found" && "folder" in state.ui.selection) {
            state.ui.selection = { view: "all" };
            persistUi();
            return refreshLists(preserveScroll);
        }
        if (listStatus === "ready") showToast(message(error));
        else {
            listStatus = { error: message(error), retry: retryLists };
            renderList();
        }
        return false;
    }
}

// Startup steps that need the library, waiting for the next list load that succeeds.
let resumeStartup: (() => Promise<void>) | null = null;
async function retryLists() {
    listStatus = "loading";
    renderList();
    await refreshLists();
}

// ---------- Saving ----------

let saveTimer = 0;
let inflight: Promise<boolean> | null = null;
let refreshPending = false;
// Bumped whenever the editor switches note, so slower reads cannot overwrite what is now open.
let navGen = 0;

const newDraft = (folder: string) => ({ folder, key: crypto.randomUUID() });
const dirty = () => (state.draft ? /[^#\s]/.test(textarea.value) : state.note !== null && textarea.value !== state.sent);

function resetSaveStatus() {
    saveFailure = null;
    saveDetailsOpen = false;
    lastSaveAttention = "";
    saveAnnouncement.textContent = "";
}

function renderSaveStatus() {
    const active = state.note !== null || state.draft !== null;
    const unsaved = dirty();
    const paused = state.conflict || editorError;
    const saving = inflight !== null && !paused;
    const failed = saveFailure !== null && !paused && !saving;
    const label = state.conflict ? "Save paused - conflict"
        : editorError ? "Save paused - editor error"
        : saving ? "Saving..."
        : failed ? "Save failed - Retry save"
        : unsaved ? "Unsaved changes"
        : state.draft ? "New note - not saved yet" : "Saved";
    const detail = state.conflict ? "Save paused. Choose Reload or Keep Mine in the conflict banner."
        : editorError ? `Save paused. ${editorErrorText} Keep this panel open and resolve the editor error before saving.`
        : saveFailure ? `${saving ? "Retrying save. Previous save failed:" : "Save failed:"} ${saveFailure} Your text is still in the editor.${saving ? "" : " Use Retry save in the toolbar."}`
        : saving ? "Saving changes. Text typed during this save will still need to be saved."
        : unsaved ? "Unsaved changes. Notes saves automatically after you stop typing."
        : state.draft ? "New note. Start writing to save it to your library."
        : "Saved. Your current text is saved to the note.";
    saveButton.hidden = saveSeparator.hidden = !active;
    saveButton.setAttribute("aria-label", label);
    saveButton.title = label;
    saveButton.className = `icon-button save-button${saving ? " saving" : ""}${failed || paused ? " attention" : ""}`;
    saveButton.replaceChildren(icon(paused || failed ? "alert" : saving ? "sync" : unsaved || state.draft ? "circle" : "check"));
    const showDetails = active && (saveDetailsOpen || !!saveFailure || editorError);
    saveDetails.hidden = !showDetails;
    saveDetails.textContent = active ? detail : "";
    saveButton.setAttribute("aria-expanded", String(showDetails));
    // Conflict and fidelity banners announce themselves; only errors and recovery need a separate save announcement.
    const attention = active && !state.conflict
        ? editorError ? `Save paused. ${editorErrorText}` : saveFailure ? `Save failed. ${saveFailure} Your text is still in the editor. Use Retry save in the toolbar.` : ""
        : "";
    if (attention !== lastSaveAttention && (attention || !saving)) {
        const recovered = lastSaveAttention.startsWith("Save failed.") && active && !state.draft && !paused;
        saveAnnouncement.textContent = attention || (recovered
            ? unsaved ? "The save error is resolved. Newer changes still need saving." : "Your changes are saved."
            : "");
        lastSaveAttention = attention;
    }
}

function setText(body: string, { resetView = false } = {}) {
    const { selectionStart, selectionEnd, scrollTop } = textarea;
    const focused = document.activeElement === textarea || rich?.isFocused || (editorWaiting && editorFocus);
    const wasPlain = plain;
    const position = rich?.state.selection.from;
    textarea.value = body;
    state.sent = textarea.value;
    saveFailure = null;
    if (resetView) resetSaveStatus();
    if (document.activeElement === textarea) textarea.setSelectionRange(selectionStart, selectionEnd);
    textarea.scrollTop = scrollTop;
    prepareEditor();
    if (!resetView && wasPlain) {
        plain = true;
        stopWaiting();
    }
    renderEditor();
    if (focused) {
        if (editorWaiting) editorFocus = true;
        else if (plain) {
            textarea.focus();
            textarea.setSelectionRange(selectionStart, selectionEnd);
        } else if (rich) rich.commands.focus(Math.min(position ?? 1, rich.state.doc.content.size));
    }
}

function loadEditor() {
    editorLoad ??= importEditor().then(module => (editorModule = module), error => {
        editorLoad = null;
        throw error;
    });
    return editorLoad;
}

function stopWaiting() {
    editorToken++;
    editorWaiting = false;
    editorFocus = false;
}

function prepareEditor() {
    editorPane.querySelector(".link-popover")?.remove();
    rich?.destroy();
    rich = null;
    richElement.replaceChildren();
    editorError = false;
    editorErrorText = "";
    guarded = false;
    stopWaiting();
    plain = !!state.note?.warning;
    if (plain || (!state.note && !state.draft)) return;
    if (!editorModule) {
        const token = editorToken;
        editorWaiting = true;
        loadEditor().then(() => {
            if (token !== editorToken) return;
            const focus = editorFocus;
            prepareEditor();
            renderEditor();
            if (focus) focusEditor();
        }, error => {
            if (token !== editorToken) return;
            const focus = editorFocus;
            stopWaiting();
            plain = true;
            renderEditor();
            showToast(`Rich editing is unavailable. Your Markdown is unchanged. ${message(error)}`);
            if (focus) focusEditor();
        });
        return;
    }
    try {
        const result = editorModule.createRichEditor({
            element: richElement, body: textarea.value, noteKey: openKey,
            change: body => { textarea.value = body; editorError = false; editorErrorText = ""; changedText(); },
            blur: () => void save(),
            error: text => { editorError = true; editorErrorText = text; clearTimeout(saveTimer); renderSaveStatus(); },
            notice: showToast,
            link: () => editLink(), open: url => void openExternal(url),
        });
        rich = result.editor;
        guarded = !result.safe;
        plain = guarded;
        markOnce("editor");
    } catch (error) {
        rich?.destroy();
        rich = null;
        plain = true;
        showToast(`Rich editing is unavailable. Your Markdown is unchanged. ${message(error)}`);
    }
}

function focusEditor() {
    if (editorWaiting) editorFocus = true;
    else if (plain || !rich) textarea.focus();
    else rich.commands.focus("end");
}

function toggleMarkdown(forceRich = false) {
    if ((!state.note && !state.draft) || editorWaiting) return;
    if (editorError) { showToast("Resolve the rich-editor error before changing views; your rich text is still in the panel."); return; }
    if (!plain) plain = true;
    else {
        prepareEditor();
        if (forceRich && rich && !state.note?.warning) { guarded = false; plain = false; }
    }
    renderEditor();
    focusEditor();
}

async function openExternal(url: string) {
    try {
        if (!safeExternal(url)) throw new Error("Only http, https and mailto links can be opened.");
        await request("api/open-link", { url });
    } catch (error) { showToast(message(error)); }
}

function editLink() {
    if (!rich || plain) return;
    const editor = rich;
    const gen = navGen;
    const selection = editor.state.selection;
    const href = String(editor.getAttributes("link").href ?? "");
    const panel = h("div", { class: "link-popover", role: "dialog", "aria-label": "Edit link" });
    const input = h("input", { type: "url", class: "text-input", "aria-label": "Link URL", value: href, placeholder: "https://example.com" });
    const errorLine = h("p", { class: "link-error", role: "alert" });
    const close = () => { panel.remove(); if (gen === navGen && rich === editor) editor.commands.focus(); };
    const apply = (remove: boolean) => {
        if (gen !== navGen || rich !== editor) return panel.remove();
        if (!remove && !safeExternal(input.value)) { errorLine.textContent = "Use an http, https or mailto URL."; return; }
        const chain = editor.chain().focus().setTextSelection({ from: selection.from, to: selection.to }).extendMarkRange("link");
        if (remove) chain.unsetLink().run();
        else if (selection.empty && !href) chain.insertContent({ type: "text", text: input.value, marks: [{ type: "link", attrs: { href: input.value } }] }).run();
        else chain.setLink({ href: input.value }).run();
        close();
    };
    panel.append(input, errorLine, h("div", { class: "link-actions" },
        h("button", { type: "button", class: "button", onclick: () => void openExternal(input.value) }, "Open"),
        h("button", { type: "button", class: "button", onclick: () => apply(true), disabled: !href }, "Remove"),
        h("button", { type: "button", class: "button", onclick: close }, "Cancel"),
        h("button", { type: "button", class: "button primary", onclick: () => apply(false) }, "Apply")));
    panel.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (event.key === "Enter" && event.target === input) { event.preventDefault(); apply(false); }
    });
    editorPane.querySelector(".link-popover")?.remove();
    editorPane.append(panel);
    input.focus();
    input.select();
}

// Hiding the focused input would drop focus to the page, so return it to the toggle.
function hideAsk() {
    const focused = askPanel.contains(document.activeElement);
    askPanel.hidden = true;
    copilotButton.setAttribute("aria-expanded", "false");
    if (focused) copilotButton.focus();
}

let asking = false;
askInput.addEventListener("keydown", async event => {
    if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); hideAsk(); return; }
    if (event.key !== "Enter" || event.isComposing || asking || !askInput.value.trim()) return;
    event.preventDefault();
    const prompt = askInput.value;
    const gen = navGen;
    asking = true;
    askInput.readOnly = true;
    askStatus.textContent = "Saving...";
    try {
        if (!(await flush({ keepDraft: true })) || gen !== navGen) { askStatus.textContent = "Not sent"; return; }
        if (!state.note) throw new Error("Write some note text before asking Copilot.");
        await request("api/ask", { id: keyOf(state.note), expectedVersion: state.note.version, prompt });
        if (gen !== navGen) return;
        askStatus.textContent = "Sent to chat";
        askInput.value = "";
        hideAsk();
        window.setTimeout(() => { if (gen === navGen && askStatus.textContent === "Sent to chat") askStatus.textContent = ""; }, 3000);
    } catch (error) { askStatus.textContent = "Not sent"; showToast(message(error)); }
    finally { asking = false; askInput.readOnly = false; }
});

function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), 1000);
}

async function save(): Promise<boolean> {
    clearTimeout(saveTimer);
    while (inflight) await inflight;
    if (state.conflict || editorError) { renderSaveStatus(); return false; }
    if (!dirty()) { saveFailure = null; renderSaveStatus(); return true; }
    const text = textarea.value;
    inflight = (async () => {
        try {
            const created = state.draft !== null;
            const note = state.draft
                ? await request<Note>("api/note/create", { body: text, folder: state.draft.folder, draft: state.draft.key })
                : await request<Note>("api/note/update", { id: keyOf(state.note!), body: text, expectedVersion: state.note!.version });
            state.draft = null;
            state.note = note;
            state.sent = text;
            saveFailure = null;
            // The library may canonicalise the title or rewrite asset links; adopt that unless the user kept typing.
            if (note.body !== text) {
                if (textarea.value === text) setText(note.body);
                else if (!created) state.conflict = true;
            }
            state.ui.noteId = keyOf(note);
            persistUi();
            renderEditor();
            return true;
        } catch (error) {
            if (error instanceof ApiError && error.code === "conflict") {
                state.conflict = true;
                renderEditor();
            } else {
                saveFailure = message(error);
            }
            return false;
        } finally {
            inflight = null;
            renderSaveStatus();
        }
    })();
    renderSaveStatus();
    const saved = await inflight;
    if (refreshPending) {
        refreshPending = false;
        void refresh();
    } else {
        void refreshLists();
    }
    return saved;
}

// Saves the open note before navigating away; false means the editor must stay put.
// An empty draft is dropped unless the caller keeps it editable until navigation commits.
async function flush({ keepDraft = false } = {}) {
    clearTimeout(saveTimer);
    for (;;) {
        while (inflight) await inflight;
        if (editorError) { showToast("The rich text could not be saved. Keep this panel open and resolve the editor error."); return false; }
        if (state.conflict) {
            showToast("Choose Reload or Keep Mine before leaving this note.");
            return false;
        }
        if (!dirty()) {
            if (!keepDraft) state.draft = null;
            return true;
        }
        if (!(await save())) {
            if (!state.conflict) showToast("This note has unsaved changes.");
            return false;
        }
    }
}

function discardEditor() {
    clearTimeout(saveTimer);
    navGen++;
    state.note = null;
    state.draft = null;
    state.conflict = false;
    state.recovered = false;
    editorError = false;
    editorErrorText = "";
    resetSaveStatus();
    state.sent = "";
    textarea.value = "";
    rich?.destroy();
    rich = null;
    stopWaiting();
    state.ui.noteId = null;
    hideAsk();
    persistUi();
}

function changedText() {
    const row = rows.querySelector(".row[aria-selected='true'] .row-title-text");
    if (row) row.textContent = titleFromText(textarea.value);
    if (!dirty()) saveFailure = null;
    renderSaveStatus();
    if (!state.conflict) scheduleSave();
}
textarea.addEventListener("input", changedText);
textarea.addEventListener("blur", () => void save());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void save(); });
// The server finishes any in-flight save first, then saves this text or keeps it for recovery on the next open.
// An unresolved conflict is only kept, never saved: closing must not choose Keep Mine for the user.
// Browsers cap keepalive bodies at about 64 KB, so larger unsaved text can still be lost when the panel closes.
addEventListener("pagehide", () => {
    if (!dirty() && !state.conflict) return;
    const body = state.draft
        ? { draft: state.draft.key, folder: state.draft.folder, body: textarea.value }
        : { id: keyOf(state.note!), folder: state.note!.folder, body: textarea.value, expectedVersion: state.note!.version,
            ...(state.conflict ? { stash: true } : {}) };
    void fetch("api/note/rescue", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .catch(() => {});
});

// ---------- Navigation ----------

async function openNote(key: string, { focus = false } = {}) {
    if (key === openKey() && !state.draft) {
        if (narrow.matches) setPane("note");
        if (focus) focusEditor();
        return;
    }
    if (!(await flush({ keepDraft: true }))) return;
    const gen = ++navGen;
    try {
        const note = await request<Note>(`api/note?id=${encodeURIComponent(key)}`);
        if (gen !== navGen) return;
        // The previous note stays editable during the read; settle anything typed or saving meanwhile.
        if (!(await flush({ keepDraft: true })) || gen !== navGen) return;
        state.note = note;
        state.draft = null;
        state.conflict = false;
        state.recovered = false;
        setText(note.body, { resetView: true });
        hideAsk();
        askStatus.textContent = "";
        editorPane.querySelector(".link-popover")?.remove();
        textarea.scrollTop = 0;
        state.ui.noteId = keyOf(note);
        persistUi();
        renderEditor();
        renderList();
        if (narrow.matches) setPane("note");
        if (focus) focusEditor();
    } catch (error) {
        showToast(message(error));
        void refreshLists();
    }
}

async function compose() {
    if (!(await flush())) return;
    navGen++;
    hideAsk();
    askStatus.textContent = "";
    const selection = state.ui.selection;
    state.note = null;
    state.conflict = false;
    state.recovered = false;
    resetSaveStatus();
    state.draft = newDraft("folder" in selection && !state.query.trim() ? selection.folder : "");
    textarea.value = "# ";
    state.sent = "";
    prepareEditor();
    state.ui.noteId = null;
    persistUi();
    renderEditor();
    renderList();
    if (narrow.matches) setPane("note");
    focusEditor();
    if (plain) textarea.setSelectionRange(2, 2);
}

async function select(selection: Selection) {
    state.ui.selection = selection;
    state.query = "";
    search.value = "";
    persistUi();
    if (narrow.matches) setPane("list");
    if (overlay) setOverlay(false);
    await refreshLists();
}

async function backToList() {
    if (await flush()) {
        renderList();
        setPane("list");
    }
}

async function applyTarget(target: Target | null) {
    if (!target) return;
    if (!(await flush())) return;
    if (target.view) state.ui.selection = { view: viewAvailable(target.view) ? target.view : "all" };
    else if (target.folder !== undefined) state.ui.selection = { folder: target.folder };
    state.query = "";
    search.value = "";
    persistUi();
    await refreshLists();
    if (target.noteId) await openNote(target.noteId);
    else if (narrow.matches) setPane("list");
}

// Runs when another panel, the agent, or this panel changed the library.
async function refresh() {
    if (inflight) {
        refreshPending = true;
        return;
    }
    await refreshLists(true);
    if (!state.note) return;
    const key = keyOf(state.note);
    const gen = navGen;
    const version = state.note.version;
    const stale = () => inflight !== null || gen !== navGen || !state.note || state.note.version !== version;
    try {
        const fresh = await request<Note>(`api/note?id=${encodeURIComponent(key)}`);
        if (stale()) return;
        if (fresh.version === state.note.version) {
            state.note = { ...fresh, body: state.note.body };
        } else if (!dirty() && !state.conflict) {
            state.note = fresh;
            setText(fresh.body);
        } else {
            state.conflict = true;
        }
        renderEditor();
    } catch (error) {
        if (!(error instanceof ApiError && error.code === "not_found") || stale()) return;
        if (dirty()) {
            navGen++;
            state.draft = newDraft(state.note!.folder);
            state.note = null;
            state.conflict = false;
            state.recovered = false;
            showToast("This note was removed elsewhere. Your text will be saved as a new note.");
            scheduleSave();
        } else {
            discardEditor();
        }
        renderEditor();
        renderList(true);
    }
}

async function resolveConflict(keepMine: boolean) {
    if (!state.note) return;
    const gen = navGen;
    const text = textarea.value;
    try {
        const fresh = await request<Note>(`api/note?id=${encodeURIComponent(keyOf(state.note))}`);
        if (gen !== navGen || (!keepMine && text !== textarea.value)) return;
        state.note = fresh;
        state.conflict = false;
        state.recovered = false;
        if (keepMine) {
            // Compare against what is on disk now, so text undone back to the old version still gets saved.
            state.sent = fresh.body;
            renderEditor();
            await save();
        } else {
            setText(fresh.body);
            renderEditor();
        }
    } catch (error) {
        showToast(message(error));
    }
}

// ---------- Note actions ----------

const freshVersion = (note: Summary) => (keyOf(note) === openKey() ? state.note!.version : note.version);

async function afterNoteMutation(note: Note) {
    if (state.note && keyOf(state.note) === keyOf(note)) {
        // A move can rewrite asset links; adopt them, or ask the user if they kept typing meanwhile.
        if (note.body !== state.note.body) {
            if (textarea.value === state.sent) setText(note.body);
            else state.conflict = true;
        }
        state.note = note;
        renderEditor();
    }
    await refreshLists();
}

async function togglePin(note: Summary) {
    if (keyOf(note) === openKey() && !(await save())) return;
    const pinned = keyOf(note) === openKey() ? state.note!.pinned : note.pinned;
    try {
        await afterNoteMutation(await request<Note>("api/note/pin", { id: keyOf(note), pinned: !pinned, expectedVersion: freshVersion(note) }));
    } catch (error) {
        showToast(message(error));
        void refresh();
    }
}

async function moveNote(note: Summary, folder: string) {
    if (note.folder === folder) return;
    if (keyOf(note) === openKey() && !(await save())) return;
    try {
        const moved = await request<Note>("api/note/move", { id: keyOf(note), folder, expectedVersion: freshVersion(note) });
        if (!moved.id && keyOf(note) === openKey()) {
            // Keep the pre-move body so afterNoteMutation can still see rewritten links.
            state.note = { ...moved, body: state.note!.body };
            state.ui.noteId = keyOf(moved);
            persistUi();
        }
        await afterNoteMutation(moved);
    } catch (error) {
        showToast(message(error));
        void refresh();
    }
}

async function deleteNote(note: Summary) {
    const key = keyOf(note);
    const isOpen = key === openKey();
    const generation = navGen;
    if (isOpen && generation === navGen) {
        clearTimeout(saveTimer);
        while (inflight) await inflight;
    }
    const neighbours = state.notes.filter(item => keyOf(item) !== key);
    const index = state.notes.findIndex(item => keyOf(item) === key);
    const body = { id: key, expectedVersion: freshVersion(note) };
    try {
        try {
            await request("api/note/delete", body);
        } catch (error) {
            if (!(error instanceof ApiError && error.code === "trash_unavailable")) throw error;
            const confirmed = await confirmDialog({
                title: "Delete permanently?",
                text: `“${note.title}” can’t be moved to the trash. Delete it permanently? This can’t be undone.`,
                confirm: "Delete Permanently",
            });
            if (!confirmed) return;
            await request("api/note/delete", { ...body, permanent: true });
        }
        if (isOpen) {
            discardEditor();
            const next = neighbours[Math.min(Math.max(index, 0), neighbours.length - 1)];
            if (next && !narrow.matches) await openNote(keyOf(next));
            else if (narrow.matches) setPane("list");
        }
        renderEditor();
        await refreshLists();
        if (isOpen && (rows.contains(document.activeElement) || document.activeElement === document.body)) rows.focus();
    } catch (error) {
        showToast(message(error));
        void refresh();
    }
}

function noteMenu(note: Summary, x: number, y: number) {
    showMenu(x, y, [
        { label: note.pinned ? "Unpin Note" : "Pin Note", icon: note.pinned ? "pin-slash" : "pin", action: () => void togglePin(note) },
        { label: "Move to…", icon: "file-moved", action: () => void moveDialog(note) },
        "-",
        { label: "Delete", icon: "trash", destructive: true, action: () => void deleteNote(note) },
    ]);
}

// ---------- Folder actions ----------

function flatFolders(node: FolderNode, depth = 0, out: { node: FolderNode; depth: number }[] = []) {
    out.push({ node, depth });
    for (const child of node.children) flatFolders(child, depth + 1, out);
    return out;
}

const totalCount = (node: FolderNode): number => node.children.reduce((sum, child) => sum + totalCount(child), node.count);

async function newFolder(parent: string) {
    const name = await promptDialog({ title: parent ? "New Subfolder" : "New Folder", label: "Folder name", value: "", confirm: "Create" });
    if (!name) return;
    try {
        const { path } = await request<{ path: string }>("api/folder/create", { name, parent });
        state.ui.collapsed = state.ui.collapsed.filter(item => item !== parent);
        await select({ folder: path });
    } catch (error) {
        showToast(message(error));
    }
}

async function renameFolder(node: FolderNode) {
    const name = await promptDialog({ title: "Rename Folder", label: "Folder name", value: node.name, confirm: "Rename" });
    if (!name || name === node.name) return;
    try {
        const { path } = await request<{ path: string }>("api/folder/rename", { folder: node.path, name, expectedVersion: node.version });
        remapFolder(node.path, path);
    } catch (error) {
        showToast(message(error));
    }
    await refreshLists();
}

async function deleteFolder(node: FolderNode) {
    const count = totalCount(node);
    const confirmed = await confirmDialog({
        title: `Delete “${node.name}”?`,
        text: `The folder${count ? `, its ${plural(count, "note")},` : ""} and everything else inside it will move to the trash.`,
        confirm: "Delete",
    });
    if (!confirmed) return;
    const openInside = state.note !== null && inside(state.note.folder, node.path);
    if (openInside) {
        clearTimeout(saveTimer);
        while (inflight) await inflight;
    }
    const body = { folder: node.path, expectedVersion: node.version, confirmed: true };
    try {
        try {
            await request("api/folder/delete", body);
        } catch (error) {
            if (!(error instanceof ApiError && error.code === "trash_unavailable")) throw error;
            const permanent = await confirmDialog({
                title: "Delete permanently?",
                text: `“${node.name}” can’t be moved to the trash. Delete it and everything inside permanently? This can’t be undone.`,
                confirm: "Delete Permanently",
            });
            if (!permanent) return;
            await request("api/folder/delete", { ...body, permanent: true });
        }
        if (openInside || (state.draft && inside(state.draft.folder, node.path))) discardEditor();
        if ("folder" in state.ui.selection && inside(state.ui.selection.folder, node.path)) state.ui.selection = { view: "all" };
        state.ui.collapsed = state.ui.collapsed.filter(path => !inside(path, node.path));
        persistUi();
        renderEditor();
    } catch (error) {
        showToast(message(error));
    }
    await refreshLists();
}

function folderMenu(node: FolderNode, x: number, y: number) {
    const locked = !node.path || !node.version;
    showMenu(x, y, [
        { label: node.path ? "New Subfolder" : "New Folder", icon: "plus", action: () => void newFolder(node.path) },
        ...(node.path ? [
            "-" as const,
            { label: "Rename…", icon: "pencil", disabled: locked, action: () => void renameFolder(node) },
            { label: "Delete…", icon: "trash", destructive: true, disabled: locked, action: () => void deleteFolder(node) },
        ] : []),
    ]);
}

async function moveDialog(note: Summary) {
    if (!state.folders) return;
    const folder = await chooseDialog(`Move “${note.title}” to`, flatFolders(state.folders), note.folder);
    if (folder !== null) await moveNote(note, folder);
}

// ---------- Menus and dialogs ----------

let menu: HTMLElement | null = null;
let menuReturn: HTMLElement | null = null;

function closeMenu(restore = false) {
    menu?.remove();
    menu = null;
    if (restore) menuReturn?.focus();
}

function showMenu(x: number, y: number, items: MenuItem[]) {
    closeMenu();
    menuReturn = document.activeElement as HTMLElement | null;
    menu = h("div", { class: "menu", role: "menu" }, ...items.map(item => item === "-"
        ? h("div", { class: "menu-separator", role: "separator" })
        : h("button", {
            type: "button", role: "menuitem", class: item.destructive ? "menu-item destructive" : "menu-item", disabled: item.disabled,
            onclick: () => { closeMenu(true); item.action(); },
        }, item.icon ? icon(item.icon) : null, item.label)));
    menu.addEventListener("keydown", event => {
        const items = [...menu!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") closeMenu(true);
        else if (event.key === "ArrowDown") items[(index + 1) % items.length]?.focus();
        else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length]?.focus();
        else if (event.key === "Tab") closeMenu(true);
        else return;
        event.preventDefault();
    });
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

document.addEventListener("pointerdown", event => { if (menu && !menu.contains(event.target as Node)) closeMenu(); }, true);
addEventListener("blur", () => closeMenu());
addEventListener("resize", () => closeMenu());

function menuAt(event: MouseEvent | KeyboardEvent, target: HTMLElement) {
    if (event instanceof MouseEvent && event.type === "contextmenu") return [event.clientX, event.clientY] as const;
    const box = target.getBoundingClientRect();
    return [box.left + 16, box.bottom - 4] as const;
}

let dialogCount = 0;
function modal<T>(title: string, build: (close: (value: T | null) => void) => Child[], initialFocus?: () => HTMLElement | null) {
    return new Promise<T | null>(resolve => {
        const id = `dialog-title-${++dialogCount}`;
        const opener = document.activeElement as HTMLElement | null;
        const sidebarOpener = !!opener && sidebar.contains(opener);
        let result: T | null = null;
        const dialog = h("dialog", { class: "dialog", "aria-labelledby": id });
        const close = (value: T | null) => { result = value; dialog.close(); };
        dialog.append(h("h2", { id, class: "dialog-title" }, title), ...build(close).filter(Boolean) as Node[]);
        dialog.addEventListener("close", () => {
            dialog.remove();
            resolve(result);
            if (sidebarOpener) queueMicrotask(() => {
                if (document.activeElement !== opener) focusTargetForViewport()?.focus();
            });
        });
        document.body.append(dialog);
        dialog.showModal();
        initialFocus?.()?.focus();
    });
}

function actions<T>(close: (value: T | null) => void, confirm: string, value: () => T | null, destructive = false) {
    return h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "button", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "button", class: destructive ? "button destructive" : "button primary", onclick: () => close(value()) }, confirm));
}

function showFormattingHelp() {
    return modal<void>("Formatting help", close => [
        h("p", { class: "dialog-text" }, "In rich text, type these at the start of a line, then press Space:"),
        h("dl", { class: "formatting-shortcuts" },
            h("dt", {}, h("code", {}, "#"), " / ", h("code", {}, "##"), " / ", h("code", {}, "###")), h("dd", {}, "Headings"),
            h("dt", {}, h("code", {}, "-"), " / ", h("code", {}, "1.")), h("dd", {}, "Bullet / numbered list"),
            h("dt", {}, h("code", {}, ">")), h("dd", {}, "Quote")),
        h("p", { class: "dialog-text" }, "For a checklist, start a bullet, then type [ ] followed by Space."),
        h("p", { class: "dialog-text" }, "Use Ctrl on Windows/Linux or Command on Mac:"),
        h("dl", { class: "formatting-shortcuts" },
            h("dt", {}, "Ctrl / Command + B"), h("dd", {}, "Bold"),
            h("dt", {}, "Ctrl / Command + I"), h("dd", {}, "Italic"),
            h("dt", {}, "Ctrl / Command + E"), h("dd", {}, "Inline code"),
            h("dt", {}, "Ctrl / Command + K"), h("dd", {}, "Edit link")),
        h("p", { class: "dialog-text" }, "View as Markdown lets you edit the source, including tables and other formatting."),
        h("div", { class: "dialog-actions" },
            h("button", { type: "button", class: "button", onclick: () => close(null) }, "Close")),
    ]);
}

async function confirmDialog({ title, text, confirm }: { title: string; text: string; confirm: string }) {
    let button: HTMLElement | null = null;
    return (await modal<boolean>(title, close => {
        const row = actions(close, confirm, () => true, true);
        button = row.firstElementChild as HTMLElement;
        return [h("p", { class: "dialog-text" }, text), row];
    }, () => button)) === true;
}

function promptDialog({ title, label, value, confirm }: { title: string; label: string; value: string; confirm: string }) {
    const input = h("input", { type: "text", class: "text-input", "aria-label": label, value, maxlength: "255", spellcheck: "false" });
    return modal<string>(title, close => {
        const submit = () => input.value.trim() || null;
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); close(submit()); }
        });
        return [input, actions(close, confirm, submit)];
    }, () => { queueMicrotask(() => input.select()); return input; });
}

function chooseDialog(title: string, folders: { node: FolderNode; depth: number }[], current: string) {
    const list = h("div", { class: "choose-list", role: "listbox", "aria-label": "Folders" });
    return modal<string>(title, close => {
        for (const { node, depth } of folders) {
            const option = h("button", {
                type: "button", class: "choose-option", role: "option", "aria-selected": String(node.path === current),
                disabled: node.path === current, onclick: () => close(node.path),
            }, icon("file-directory"), node.name);
            option.style.setProperty("--depth", String(depth));
            list.append(option);
        }
        return [list, h("div", { class: "dialog-actions" }, h("button", { type: "button", class: "button", onclick: () => close(null) }, "Cancel"))];
    }, () => list.querySelector<HTMLElement>("button:not(:disabled)"));
}

// ---------- Rendering ----------

function smartButton(view: "all" | "project" | "session", label: string, iconName: string, count?: number, title?: string) {
    const selection = state.ui.selection;
    const current = !state.query.trim() && "view" in selection && selection.view === view;
    return h("button", {
        type: "button", class: "folder-button smart-button", "data-focus-key": `smart:${view}`, "aria-current": current ? "true" : undefined, title,
        onclick: () => void select({ view }),
    }, icon(iconName), h("span", { class: "folder-name" }, label), count === undefined ? null : h("span", { class: "folder-count" }, String(count)));
}

function folderRow(node: FolderNode, depth: number): HTMLElement {
    const selection = state.ui.selection;
    const current = !state.query.trim() && "folder" in selection && selection.folder.toLowerCase() === node.path.toLowerCase();
    const collapsed = state.ui.collapsed.includes(node.path);
    const button = h("button", {
        type: "button", class: "folder-button", "data-focus-key": `folder:${node.path}`, "aria-current": current ? "true" : undefined,
        title: node.warning?.message,
        onclick: () => void select({ folder: node.path }),
        ondblclick: () => { if (node.path && node.version) void renameFolder(node); },
        oncontextmenu: (event: MouseEvent) => { event.preventDefault(); folderMenu(node, ...menuAt(event, button)); },
        onkeydown: (event: KeyboardEvent) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                folderMenu(node, ...menuAt(event, button));
            }
        },
    }, icon(node.warning ? "alert" : "file-directory"), h("span", { class: "folder-name" }, node.path ? node.name : "Notes"),
        h("span", { class: "folder-count" }, String(node.count)));
    const toggle = node.children.length
        ? iconButton(collapsed ? "chevron-right" : "chevron-down", `${collapsed ? "Expand" : "Collapse"} ${node.name}`, () => {
            state.ui.collapsed = collapsed ? state.ui.collapsed.filter(path => path !== node.path) : [...state.ui.collapsed, node.path];
            persistUi();
            renderSidebar();
        }, { class: "icon-button disclosure", "data-focus-key": `disclosure:${node.path}`, "aria-expanded": String(!collapsed) })
        : h("span", { class: "disclosure" });
    const row = h("div", { class: "folder-row" }, toggle, button);
    row.style.setProperty("--depth", String(depth));
    row.addEventListener("dragover", event => {
        if (!event.dataTransfer?.types.includes(NOTE_KEY)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", event => {
        row.classList.remove("drop-target");
        const key = event.dataTransfer?.getData(NOTE_KEY);
        const note = state.notes.find(item => keyOf(item) === key) ?? (state.note && keyOf(state.note) === key ? state.note : undefined);
        if (!note) return;
        event.preventDefault();
        void moveNote(note, node.path);
    });
    const group = h("div", { class: "folder-group" }, row);
    if (!collapsed) for (const child of node.children) group.append(folderRow(child, depth + 1));
    return group;
}

function renderSidebar() {
    const identity = (item: Element) => item.getAttribute("data-focus-key") ?? item.getAttribute("aria-label") ?? item.textContent;
    const focused = document.activeElement && sidebar.contains(document.activeElement) ? identity(document.activeElement) : null;
    smart.replaceChildren(...[
        smartButton("all", "All Notes", "note", state.folders ? totalCount(state.folders) : undefined),
        state.context.project ? smartButton("project", "This Project", "repo", undefined, state.context.project) : null,
        state.context.sessionId ? smartButton("session", "This Session", "comment-discussion", undefined, state.context.sessionName ?? undefined) : null,
    ].filter(button => button !== null));
    tree.replaceChildren(...(state.folders ? [folderRow(state.folders, 0)] : []));
    if (focused) {
        const match = [...sidebar.querySelectorAll<HTMLElement>("button")].find(item => identity(item) === focused);
        match?.focus();
    }
}

sidebar.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!(event.target instanceof HTMLElement) || !event.target.matches("button")) return;
    const buttons = [...sidebar.querySelectorAll<HTMLButtonElement>(".folder-button")];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    buttons[next]?.focus();
});

function selectionName() {
    const selection = state.ui.selection;
    if ("view" in selection) return { all: "All Notes", project: "This Project", session: "This Session" }[selection.view];
    if (!selection.folder) return "Notes";
    return selection.folder.split("/").pop()!;
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const DAY = 86_400_000;
// toLocale*String builds a formatter per call, which dominated rendering long lists; these are built once.
let formats: Record<"month" | "time" | "weekday" | "date", Intl.DateTimeFormat> | null = null;
const dateFormats = () => formats ??= {
    month: new Intl.DateTimeFormat(undefined, { month: "long" }),
    time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "long" }),
    date: new Intl.DateTimeFormat(undefined, { year: "2-digit", month: "numeric", day: "numeric" }),
};

function groupOf(iso: string, today: number) {
    const time = Date.parse(iso);
    if (time >= today) return "Today";
    if (time >= today - DAY) return "Yesterday";
    if (time >= today - 7 * DAY) return "Previous 7 Days";
    if (time >= today - 30 * DAY) return "Previous 30 Days";
    const year = new Date(time).getFullYear();
    return year === new Date(today).getFullYear() ? dateFormats().month.format(time) : String(year);
}

function shortDate(iso: string, today: number) {
    const time = Date.parse(iso);
    if (time >= today) return dateFormats().time.format(time);
    if (time >= today - DAY) return "Yesterday";
    if (time >= today - 6 * DAY) return dateFormats().weekday.format(time);
    return dateFormats().date.format(time);
}

function highlight(text: string, words: string[]): Child[] {
    if (!words.length) return [text];
    const lower = text.toLowerCase();
    const out: Child[] = [];
    let index = 0;
    while (index < text.length) {
        let best = -1;
        let length = 0;
        for (const word of words) {
            const found = lower.indexOf(word, index);
            if (found !== -1 && (best === -1 || found < best || (found === best && word.length > length))) {
                best = found;
                length = word.length;
            }
        }
        if (best === -1) {
            out.push(text.slice(index));
            break;
        }
        if (best > index) out.push(text.slice(index, best));
        out.push(h("mark", {}, text.slice(best, best + length)));
        index = best + length;
    }
    return out;
}

function preview(note: Summary) {
    let text = note.snippet ?? "";
    if (text.startsWith(note.title)) text = text.slice(note.title.length).trim();
    return text || "No additional text";
}

function noteRow(note: Summary, words: string[], searching: boolean, today: number) {
    const key = keyOf(note);
    const selected = key === openKey() && !state.draft;
    const row = h("div", {
        class: "row", role: "option", tabindex: "-1", "aria-selected": String(selected), draggable: "true", "data-key": key,
        onclick: () => void openNote(key),
        ondblclick: () => void openNote(key, { focus: true }),
        oncontextmenu: (event: MouseEvent) => { event.preventDefault(); noteMenu(note, ...menuAt(event, row)); },
        ondragstart: (event: DragEvent) => {
            event.dataTransfer?.setData(NOTE_KEY, key);
            event.dataTransfer?.setData("text/plain", note.title);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        },
    },
    h("div", { class: "row-title" },
        note.warning ? icon("alert") : null,
        note.created_by === "agent" ? h("span", { class: "agent-mark", title: "Created by Copilot" }, icon("copilot")) : null,
        h("span", { class: "row-title-text" }, ...highlight(note.title, words)),
        note.pinned && searching ? icon("pin") : null),
    h("div", { class: "row-meta" },
        h("span", { class: "row-date" }, shortDate(note.lastEdited, today)),
        h("span", { class: "row-preview" }, ...highlight(preview(note), words))),
    searching ? h("div", { class: "row-folder" }, icon("file-directory"), note.folder ? note.folder.split("/").pop()! : "Notes") : null);
    return row;
}

function renderList(preserveScroll = false) {
    const searching = state.query.trim() !== "";
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    listTitle.textContent = searching ? "Search" : selectionName();
    listCount.textContent = listStatus !== "ready" ? "" : searching ? plural(state.notes.length, "result") : plural(state.notes.length, "note");
    const children: HTMLElement[] = [];
    if (state.draft) {
        children.push(h("div", { class: "row draft", role: "option", tabindex: "-1", "aria-selected": "true" },
            h("div", { class: "row-title" }, h("span", { class: "row-title-text" }, titleFromText(textarea.value))),
            h("div", { class: "row-meta" }, h("span", { class: "row-date" }, "Now"), h("span", { class: "row-preview" }, "No additional text"))));
    }
    const today = startOfDay(new Date());
    if (searching) {
        children.push(...state.notes.map(note => noteRow(note, words, true, today)));
    } else {
        const groups = new Map<string, Summary[]>();
        for (const note of state.notes) {
            const name = note.pinned ? "Pinned" : groupOf(note.lastEdited, today);
            const group = groups.get(name);
            if (group) group.push(note);
            else groups.set(name, [note]);
        }
        const ordered = [...groups].sort(([a], [b]) => Number(b === "Pinned") - Number(a === "Pinned"));
        for (const [name, notes] of ordered) {
            const id = `group-${name.replace(/\W+/g, "-")}`;
            children.push(h("div", { class: "group", role: "group", "aria-labelledby": id },
                h("div", { class: "group-title", id, role: "presentation" }, name === "Pinned" ? icon("pin") : null, name),
                ...notes.map(note => noteRow(note, words, false, today))));
        }
    }
    const empty = !children.length;
    if (listStatus === "loading") {
        children.push(h("div", { class: "list-empty", role: "status" }, "Loading notes…"));
    } else if (listStatus !== "ready") {
        children.push(h("div", { class: "list-empty list-error", role: "alert" },
            h("p", {}, listStatus.error),
            h("button", { type: "button", class: "button", onclick: listStatus.retry }, "Try again")));
    } else if (empty) {
        const selection = state.ui.selection;
        const invitation = "folder" in selection ? "No notes in this folder"
            : selection.view !== "all" ? `No notes in ${selectionName().toLowerCase()}`
            : "Capture your first thought";
        children.push(h("div", { class: "list-empty" },
            h("p", {}, searching ? "No matching notes" : invitation),
            h("p", { class: "empty-detail" }, searching ? "Try a different search."
                : "folder" in selection ? "Create a note here to get started."
                : selection.view !== "all" ? "New notes are saved in Notes."
                : "Create a note to keep ideas and decisions close."),
            searching ? null : h("button", { type: "button", class: "button", onclick: () => void compose() }, "Create note")));
    }
    const hadFocus = rows.contains(document.activeElement);
    rows.replaceChildren(...children);
    if (empty) {
        rows.removeAttribute("role");
        rows.removeAttribute("aria-label");
    } else {
        rows.setAttribute("role", "listbox");
        rows.setAttribute("aria-label", "Notes");
    }
    const options = [...rows.querySelectorAll<HTMLElement>(".row")];
    const current = options.find(row => row.getAttribute("aria-selected") === "true") ?? options[0];
    current?.setAttribute("tabindex", "0");
    rows.setAttribute("tabindex", "-1");
    if (hadFocus) (current ?? rows.querySelector("button") ?? search).focus({ preventScroll: preserveScroll });
    if (!preserveScroll) current?.scrollIntoView({ block: "nearest" });
}

rows.addEventListener("keydown", event => {
    if (event.key === "Enter" && (document.activeElement as HTMLElement)?.classList.contains("draft")) {
        event.preventDefault();
        focusEditor();
        return;
    }
    const options = [...rows.querySelectorAll<HTMLElement>(".row:not(.draft)")];
    const index = options.indexOf(document.activeElement as HTMLElement);
    const note = state.notes.find(item => keyOf(item) === (document.activeElement as HTMLElement)?.dataset.key);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const next = options[Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
            next.focus();
            void openNote(next.dataset.key!);
        }
    } else if (event.key === "Enter" && note) {
        void openNote(keyOf(note), { focus: true });
    } else if (event.key === "Delete" && note) {
        void deleteNote(note);
    } else if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && note) {
        noteMenu(note, ...menuAt(event, document.activeElement as HTMLElement));
    } else {
        return;
    }
    event.preventDefault();
});

function renderEditor() {
    const active = state.note !== null || state.draft !== null;
    renderSaveStatus();
    textarea.hidden = !active || !plain || editorWaiting;
    richElement.hidden = !active || plain || editorWaiting;
    editorLoading.hidden = !active || !editorWaiting;
    markdownButton.disabled = !active || !!state.note?.warning || editorWaiting;
    markdownButton.setAttribute("aria-pressed", String(plain));
    markdownButton.setAttribute("aria-label", plain ? "View as rich text" : "View as Markdown");
    markdownButton.title = plain ? "View as rich text" : "View as Markdown";
    copilotButton.disabled = !active;
    fidelityBanner.hidden = !active || !guarded;
    if (guarded) fidelityBanner.replaceChildren(h("span", {}, GUARD_MESSAGE),
        h("button", { type: "button", class: "button", onclick: () => toggleMarkdown(true) }, "Edit rich anyway"));
    emptyEditor.hidden = active;
    formattingHelp.hidden = !active || plain || editorWaiting;
    dateLine.textContent = state.draft
        ? "New Note"
        : state.note ? new Date(state.note.lastEdited).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) : "";
    for (const button of [pinButton, moveButton, trashButton]) button.disabled = !state.note;
    const pinned = state.note?.pinned === true;
    pinButton.replaceChildren(icon(pinned ? "pin-slash" : "pin"));
    pinButton.setAttribute("aria-label", pinned ? "Unpin note" : "Pin note");
    pinButton.title = pinned ? "Unpin note" : "Pin note";
    if (state.conflict) {
        banner.className = "banner conflict";
        banner.replaceChildren(icon("alert"),
            h("span", {}, state.recovered ? "Recovered unsaved text from when Notes last closed." : "Changed elsewhere"),
            h("button", { type: "button", class: "button", onclick: () => void resolveConflict(false) }, "Reload"),
            h("button", { type: "button", class: "button primary", onclick: () => void resolveConflict(true) }, "Keep Mine"));
        banner.hidden = false;
    } else if (state.note?.warning) {
        banner.className = "banner";
        banner.replaceChildren(icon("alert"), h("span", {}, state.note.warning.message));
        banner.hidden = false;
    } else {
        banner.hidden = true;
    }
}

// ---------- Start ----------

let searchTimer = 0;
search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        state.query = search.value;
        renderSidebar();
        void refreshLists();
    }, 150);
});
search.addEventListener("keydown", event => {
    if (event.key === "Escape" && search.value) {
        event.preventDefault();
        search.value = "";
        search.dispatchEvent(new Event("input"));
    } else if (event.key === "ArrowDown") {
        event.preventDefault();
        (rows.querySelector<HTMLElement>(".row:not(.draft)") ?? rows).focus();
    }
});

function closeOverlayOnEscape(target: EventTarget | null) {
    if (overlay && !(target as Element | null)?.closest?.("dialog[open]")) setOverlay(false);
}

document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeOverlayOnEscape(event.target);
});

let eventsConnected = false;
function connectEvents() {
    if (eventsConnected) return;
    eventsConnected = true;
    const events = new EventSource("api/events");
    let opened = false;
    events.addEventListener("open", () => {
        if (opened) void refresh();
        opened = true;
    });
    events.addEventListener("changed", () => void refresh());
    events.addEventListener("reveal", event => void applyTarget(JSON.parse((event as MessageEvent).data)));
    addEventListener("pagehide", () => { events.close(); rich?.destroy(); }, { once: true });
}

// The user moved on before recovered text could be shown; keep it for the next load rather than replacing their editor.
// Resolves whether the server kept it.
const stashBody = ({ noteId, folder, body }: Recovery) => ({ ...(noteId ? { id: noteId } : {}), folder, body, stash: true });
function stashRecovery(recovery: Recovery) {
    return request("api/note/rescue", stashBody(recovery)).then(() => true, () => false);
}

// Recovered text the server has not confirmed keeping stays here until it does: retried on each list load,
// and sent when the panel closes, even while a stash is still in flight.
const heldRecoveries = new Set<Recovery>();
let retryingRecoveries = false;
async function keepRecovery(recovery: Recovery) {
    heldRecoveries.add(recovery);
    if (await stashRecovery(recovery)) heldRecoveries.delete(recovery);
    else showToast("Notes could not keep recovered unsaved text yet; it will try again.");
}
async function retryHeldRecoveries() {
    if (retryingRecoveries) return;
    retryingRecoveries = true;
    for (const recovery of [...heldRecoveries]) {
        if (await stashRecovery(recovery)) heldRecoveries.delete(recovery);
    }
    retryingRecoveries = false;
}
addEventListener("pagehide", () => {
    for (const recovery of new Set([...claimedRecoveries, ...heldRecoveries])) {
        void fetch("api/note/rescue", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(stashBody(recovery)) })
            .catch(() => {});
    }
});

// Recovered text the server handed over that is not yet in the editor or kept again; closing sends it back.
const claimedRecoveries = new Set<Recovery>();
async function recover(recovery: Recovery) {
    claimedRecoveries.add(recovery);
    try {
        await showRecovery(recovery);
    } finally {
        claimedRecoveries.delete(recovery);
    }
}

// Shows text a closing panel could not save, as a conflict the user resolves with Reload or Keep Mine.
async function showRecovery(recovery: Recovery) {
    const { noteId, folder, body } = recovery;
    const gen = ++navGen;
    let note: Note | null = null;
    try {
        note = noteId ? await request<Note>(`api/note?id=${encodeURIComponent(noteId)}`) : null;
    } catch (error) {
        // The library could not answer; keep the text for the next load rather than saving it as a copy.
        // If even that fails, fall through and show it as a new draft so it is not lost.
        if (error instanceof ApiError && (error.code === "library_busy" || error.code === "offline") && await stashRecovery(recovery)) {
            return showToast(message(error));
        }
        /* the note is gone; recover the text as a new draft */
    }
    // The user moved on while this loaded; hand the text back to the server rather than replacing their editor.
    if (gen !== navGen) return keepRecovery(recovery);
    if (note?.body === body) return void (await openNote(keyOf(note)));
    state.note = note;
    state.draft = note ? null : newDraft(folder);
    state.sent = note?.body ?? "";
    state.conflict = note !== null;
    state.recovered = note !== null;
    resetSaveStatus();
    textarea.value = body;
    prepareEditor();
    state.ui.noteId = state.note ? keyOf(state.note) : null;
    persistUi();
    renderEditor();
    renderList();
    if (narrow.matches) setPane("note");
    if (state.draft) {
        showToast("Recovered unsaved text from when Notes last closed.");
        scheduleSave();
    }
}

type Initial = { context: typeof state.context; ui: UiState };
type Startup = { target: Target | null; recovery: Recovery | null };

// Composing before startup finishes wins over the restored note and recovered text, even across retries.
async function start(gen = navGen) {
    markOnce("start");
    resumeStartup = null;
    // Requests begin before the first render. Neither has side effects: the open target and recovered text are
    // claimed separately, once the lists load, so a library that cannot load yet never loses them.
    const initialRequest = request<Initial>("api/state");
    const foldersRequest = request<{ folders: FolderNode }>("api/folders");
    foldersRequest.catch(() => { /* refreshLists reports it */ });
    listStatus = "loading";
    layout();
    renderList();
    renderEditor();
    let initial: Initial;
    try {
        initial = await initialRequest;
    } catch (error) {
        listStatus = { error: message(error), retry: () => start(gen) };
        // A search or refresh that loads the lists later must not leave startup unfinished either.
        resumeStartup = () => start(gen);
        return renderList();
    }
    state.context = initial.context;
    copilotButton.hidden = !state.context.sessionId;
    const stale = gen !== navGen;
    state.ui = stale ? { ...initial.ui, selection: state.ui.selection, noteId: state.ui.noteId } : initial.ui;
    const selection = state.ui.selection;
    if ("view" in selection && !viewAvailable(selection.view)) state.ui.selection = { view: "all" };
    layout();
    // The restored note loads alongside the list rather than after it; the list request is issued first.
    const restoreKey = stale ? null : state.ui.noteId;
    let restored: Promise<Note> | null = null;
    // A read that failed while the library was loading is read again rather than reused.
    const restore = () => {
        const note = restoreKey ? request<Note>(`api/note?id=${encodeURIComponent(restoreKey)}`) : null;
        note?.catch(error => {
            if (restored === note && !(error instanceof ApiError && error.code === "not_found")) restored = null;
        });
        return note;
    };
    // Runs after the first list load that succeeds, here or from a retry, search or refresh.
    resumeStartup = () => finishStartup(gen, stale, restored ?? restore());
    const lists = refreshLists(false, foldersRequest);
    restored = restore();
    // Fetching and evaluating the editor would delay the list requests, so it starts once they are sent.
    loadEditor().catch(() => { /* prepareEditor retries and reports it */ });
    await lists;
}

async function finishStartup(gen: number, stale: boolean, restored: Promise<Note> | null) {
    let claimed: Startup = { target: null, recovery: null };
    try {
        claimed = await request<Startup>("api/startup", {});
    } catch (error) {
        // Nothing was handed over; a pending reveal still reaches the event stream below.
        showToast(message(error));
    }
    const { target, recovery } = claimed;
    if (stale || gen !== navGen) {
        state.ui.noteId = state.note ? keyOf(state.note) : null;
        if (recovery) await keepRecovery(recovery);
        return connectEvents();
    }
    if (recovery) await recover(recovery);
    else if (target) await applyTarget(target);
    else if (restored) {
        try {
            const note = await restored;
            if (gen !== navGen) return connectEvents();
            state.note = note;
            setText(note.body, { resetView: true });
            renderEditor();
            renderList();
        } catch (error) {
            // Forget the restored note only when it is gone, not when the library was briefly unavailable.
            if (error instanceof ApiError && error.code === "not_found") {
                state.ui.noteId = null;
                persistUi();
            } else {
                showToast(message(error));
            }
        }
    }
    connectEvents();
}

void start();