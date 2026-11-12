import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NotesError } from "./errors.mjs";
import { copilotHome } from "./platform.mjs";

export const DEFAULT_UI_STATE = Object.freeze({ sidebar: true, selection: { view: "all" }, noteId: null, collapsed: [] });

export function uiStatePath(home = copilotHome()) {
    return join(home, "extensions", "notes", "artifacts", "ui-state.json");
}

// Unsaved text a closing panel could not save; holds note content, so entries are consumed on next load.
// One file per entry, claimed by rename, so panels in other sessions cannot overwrite or double-deliver entries.
export const recoveryPath = (statePath) => join(dirname(statePath), "recovery");

async function writeAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        await rename(temp, path);
    } finally {
        await rm(temp, { force: true });
    }
}

const entryFiles = async (dir) => (await readdir(dir).catch(() => [])).filter(name => /^\d{15}-[0-9a-f]{12}\.json$/.test(name)).sort();

export async function pushRecovery(dir, { noteId = null, folder = "", body }) {
    await writeAtomic(join(dir, `${String(Date.now()).padStart(15, "0")}-${randomBytes(6).toString("hex")}.json`), { noteId, folder, body });
    const files = await entryFiles(dir);
    await Promise.all(files.slice(0, -20).map(name => rm(join(dir, name), { force: true })));
}

export async function popRecovery(dir) {
    for (const name of await entryFiles(dir)) {
        const claimed = join(dir, `${name}.${randomBytes(6).toString("hex")}.claimed`);
        try {
            await rename(join(dir, name), claimed);
        } catch {
            continue;
        }
        try {
            const entry = JSON.parse(await readFile(claimed, "utf8"));
            if (entry && typeof entry.body === "string" && (entry.noteId === null || isText(entry.noteId, 4096)) && isText(entry.folder, 4096)) {
                return { noteId: entry.noteId, folder: entry.folder, body: entry.body };
            }
        } catch { /* skip unreadable entries */ } finally {
            await rm(claimed, { force: true });
        }
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
