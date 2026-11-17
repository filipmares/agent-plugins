import { posix } from "node:path";
import { compareNames } from "./library-snapshot.mjs";
import { foldText, markdownText, titleOf } from "./note-format.mjs";

export const inFolder = (path, folder) => folder === "" || path === folder || path.startsWith(`${folder}/`);
export const folderOf = path => posix.dirname(path) === "." ? "" : posix.dirname(path);
export const searchText = note => note.warning ? note.body : markdownText(note.body);

export function summary(note) {
    return {
        id: note.metadata.id ?? null,
        path: note.path,
        title: note.title ?? note.metadata.title ?? titleOf(note.body),
        folder: folderOf(note.path),
        updated: note.metadata.updated ?? null,
        lastEdited: new Date(Math.max(Date.parse(note.metadata.updated) || 0, note.stats.mtimeMs)).toISOString(),
        project: note.metadata.project ?? null,
        created_by: note.metadata.created_by ?? null,
        pinned: note.metadata.pinned === true,
        version: note.version,
        ...(note.warning ? { warning: note.warning } : {}),
    };
}

export function listNotes({ notes, warnings }, { words, project, session, folder }) {
    const matches = [];
    for (const note of notes) {
        if (project !== undefined && note.metadata.project !== project) continue;
        if (session !== undefined && !note.metadata.sessions?.includes(session)) continue;
        if (folder !== undefined && !inFolder(folderOf(note.path), folder)) continue;
        const text = note.text ?? searchText(note);
        const item = summary(note);
        const folded = words.length ? foldText(text) : "";
        const title = words.length ? foldText(item.title) : "";
        if (!words.every(word => folded.includes(word) || title.includes(word))) continue;
        const match = words.length ? Math.max(0, folded.indexOf(words[0])) : 0;
        const start = Math.max(0, match - 40);
        const snippet = ((start ? "..." : "") + text.slice(start, start + 180) + (text.length > start + 180 ? "..." : ""))
            .replace(/\s+([.,;:!?)\]])/g, "$1");
        matches.push({ ...item, snippet, titleMatch: words.every(word => title.includes(word)) });
    }
    matches.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch)
        || Date.parse(b.lastEdited) - Date.parse(a.lastEdited) || compareNames(a.path, b.path));
    return { notes: matches.map(({ titleMatch, ...item }) => item), warnings };
}
