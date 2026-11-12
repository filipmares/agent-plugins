import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NotesError } from "./errors.mjs";
import { retryTransient } from "./filesystem.mjs";
import { copilotHome } from "./platform.mjs";

export const DEFAULT_UI_STATE = Object.freeze({ sidebar: true, selection: { view: "all" }, noteId: null, collapsed: [] });

export function uiStatePath(home = copilotHome()) {
    return join(home, "extensions", "notes", "artifacts", "ui-state.json");
}

// Unsaved text a closing panel could not save; holds note content, so entries are consumed on next load.
// One file per entry, claimed with an exclusive-create marker, so panels in other sessions cannot overwrite or double-deliver entries.
export const recoveryPath = (statePath) => join(dirname(statePath), "recovery");

const discard = (path) => retryTransient(() => rm(path, { force: true }));

// Only an exclusive create is atomic everywhere: on Windows two renames of one file can both succeed.
async function claimEntry(path) {
    try {
        await (await open(`${path}.claim`, "wx")).close();
        return true;
    } catch {
        return false;
    }
}

// Entry first, so a late claimer that finds the marker gone also finds no entry. If the entry cannot be removed, its marker stays.
async function removeEntry(path) {
    await discard(path);
    await discard(`${path}.claim`);
}

async function writeAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        await retryTransient(() => rename(temp, path));
    } finally {
        await discard(temp);
    }
}

const entryFiles = async (dir) => (await readdir(dir).catch(() => [])).filter(name => /^\d{15}-[0-9a-f]{12}\.json$/.test(name)).sort();

export async function pushRecovery(dir, { noteId = null, folder = "", body }) {
    await writeAtomic(join(dir, `${String(Date.now()).padStart(15, "0")}-${randomBytes(6).toString("hex")}.json`), { noteId, folder, body });
    // Trimming claims like a reader does, so it never removes an entry another panel is about to deliver.
    await Promise.all((await entryFiles(dir)).slice(0, -20).map(async name => {
        const path = join(dir, name);
        if (await claimEntry(path)) await removeEntry(path);
    }));
}

export async function popRecovery(dir) {
    for (const name of await entryFiles(dir)) {
        const path = join(dir, name);
        if (!await claimEntry(path)) continue;
        let draft = null;
        try {
            const entry = JSON.parse(await retryTransient(() => readFile(path, "utf8")));
            if (entry && typeof entry.body === "string" && (entry.noteId === null || isText(entry.noteId, 4096)) && isText(entry.folder, 4096)) {
                draft = { noteId: entry.noteId, folder: entry.folder, body: entry.body };
            }
        } catch { /* skip unreadable or already-consumed entries */ }
        // A failed cleanup must not lose a draft that was already read; the marker left behind prevents a second delivery.
        await removeEntry(path).catch(() => {});
        if (draft) return draft;
    }
    return null;
}

const isText = (value, max) => typeof value === "string" && value.length <= max;

export function validateUiState(value) {
    const ok = value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).every(key => key in DEFAULT_UI_STATE)
        && typeof value.sidebar === "boolean"
        && value.selection && typeof value.selection === "object" && !Array.isArray(value.selection)
        && (Object.keys(value.selection).length === 1)
        && (["all", "project", "session"].includes(value.selection.view) || isText(value.selection.folder, 4096))
        && (value.noteId === null || isText(value.noteId, 4096))
        && Array.isArray(value.collapsed) && value.collapsed.length <= 1000 && value.collapsed.every(path => isText(path, 4096));
    if (!ok) throw new NotesError("invalid_request", "The UI state does not match the expected shape.");
    return { sidebar: value.sidebar, selection: { ...value.selection }, noteId: value.noteId, collapsed: [...value.collapsed] };
}

export async function loadUiState(path) {
    try {
        return validateUiState(JSON.parse(await readFile(path, "utf8")));
    } catch {
        return structuredClone(DEFAULT_UI_STATE);
    }
}

export async function saveUiState(path, value) {
    const state = validateUiState(value);
    await writeAtomic(path, state);
    return state;
}
