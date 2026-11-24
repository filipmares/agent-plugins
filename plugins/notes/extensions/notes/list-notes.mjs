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

function foldedOffset(text, target) {
    if (target <= 0) return 0;
    if (/^[\x00-\x7f]*$/.test(text)) return target;
    let folded = 0;
    for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i);
        const len = cp > 0xffff ? 2 : 1;
        const width = foldText(text.slice(i, i + len)).length;
        if (width > 0 && folded >= target) return i;
        folded += width;
        i += len;
    }
    return text.length;
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
        let match = -1;
        for (const word of words) {
            match = folded.indexOf(word);
            if (match >= 0) break;
        }
        const start = match > 40 ? foldedOffset(text, match - 40) : 0;
        let end = Math.min(text.length, start + 180);
        if (end < text.length && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end++;
        while (end < text.length) {
            const cp = text.codePointAt(end);
            const len = cp > 0xffff ? 2 : 1;
            if (!/\p{M}/u.test(text.slice(end, end + len))) break;
            end += len;
        }
        const snippet = ((start ? "..." : "") + text.slice(start, end) + (text.length > end ? "..." : ""))
            .replace(/\s+([.,;:!?)\]])/g, "$1");
        matches.push({ ...item, snippet, titleMatch: words.every(word => title.includes(word)) });
    }
    matches.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch)
        || Date.parse(b.lastEdited) - Date.parse(a.lastEdited) || compareNames(a.path, b.path));
    return { notes: matches.map(({ titleMatch, ...item }) => item), warnings };
}
