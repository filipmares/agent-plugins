import { readdir } from "node:fs/promises";
import { NotesError } from "./errors.mjs";
import { readNoteFile, resolveInside, visiblePath } from "./filesystem.mjs";
import { contentHash, parseNote } from "./note-format.mjs";

export const compareNames = (a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) || a.localeCompare(b, "en");

// Read-only discovery shared with the background index; adoption remains in NotesLibrary.
export async function readLibrarySnapshot(root, { retryConflicts = false } = {}) {
    const notes = [], folders = [""], warnings = [];
    async function walk(folder) {
        const directory = await resolveInside(root, folder);
        for (const entry of (await readdir(directory.path, { withFileTypes: true })).sort((a, b) => compareNames(a.name, b.name))) {
            const path = folder ? `${folder}/${entry.name}` : entry.name;
            if (!visiblePath(path)) continue;
            if (entry.isSymbolicLink()) {
                warnings.push({ path, code: "unsafe_path", message: "Symlinks are not indexed." });
            } else if (entry.isDirectory()) {
                folders.push(path);
                await walk(path);
            } else if (/\.md$/i.test(entry.name)) {
                try {
                    const file = await readNoteFile(root, path);
                    notes.push({ ...file, ...parseNote(file.raw), path });
                } catch (error) {
                    if (!(error instanceof NotesError)) throw error;
                    if (retryConflicts && ["conflict", "not_found"].includes(error.code)) throw error;
                    warnings.push({ path, code: error.code, message: error.message });
                }
            }
        }
    }
    await walk("");
    notes.sort((a, b) => a.stats.birthtimeMs - b.stats.birthtimeMs || compareNames(a.path, b.path));
    return { notes, folders, warnings };
}

export function snapshotSignature({ notes, folders, warnings }) {
    return contentHash(JSON.stringify({
        notes: notes.map(note => [note.path, note.version, note.stats.mtimeMs]),
        folders, warnings,
    }));
}
