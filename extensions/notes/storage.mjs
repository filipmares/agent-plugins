import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { NotesError, requireString } from "./errors.mjs";
import {
    adoptionId, contentHash, foldText, folderName, localTimestamp, markdownText,
    newId, newNoteBody, parseNote, renameAssetLinks, serializeNote, slug, titleOf, ULID,
} from "./note-format.mjs";
import {
    readNoteFile, relativePath, removeNoteFile, requireVersion, resolveInside,
    visiblePath, withLibraryLock, writeNoteFile,
} from "./filesystem.mjs";
import { trashItem } from "./platform.mjs";

const nameKey = name => name.normalize("NFC").toLowerCase();
const inFolder = (path, folder) => folder === "" || path === folder || path.startsWith(`${folder}/`);
const folderOf = path => posix.dirname(path) === "." ? "" : posix.dirname(path);
const joinPath = (parent, name) => parent ? `${parent}/${name}` : name;
const assetPath = path => path.slice(0, -3) + ".assets";
const compareNames = (a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) || a.localeCompare(b, "en");

function hasAutomaticName(note) {
    const base = slug(titleOf(note.body));
    const stem = posix.basename(note.path).slice(0, -3);
    const suffix = /-(?:[2-9]|[1-9]\d+)$/.exec(stem)?.[0];
    return !note.warning && !!note.metadata.created_by
        && (stem === base || (suffix && stem === Array.from(base).slice(0, 40 - suffix.length).join("") + suffix));
}

function assertContext(context) {
    if (!context || typeof context.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context.sessionId)) {
        throw new NotesError("invalid_session", "A valid calling session is required for note edits.");
    }
    if (!["user", "agent"].includes(context.actor)) {
        throw new NotesError("invalid_request", "The author must be user or agent.");
    }
}

function summary(note) {
    return {
        id: note.metadata.id ?? null,
        path: note.path,
        title: titleOf(note.body),
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

function payload(note) {
    return { ...summary(note), body: note.body, frontmatter: note.metadata };
}

function requireNotePath(path) {
    const normalized = relativePath(path);
    if (!visiblePath(normalized) || !/\.md$/i.test(normalized)) {
        throw new NotesError("invalid_path", "Choose a .md note outside hidden and .assets folders.");
    }
    return normalized;
}

async function exists(path) {
    try { await lstat(path); return true; } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

export class NotesLibrary {
    #directory;
    #root;
    #trash;
    #now;

    constructor(directory, { trash = trashItem, now = () => new Date() } = {}) {
        if (typeof directory !== "string" || !isAbsolute(directory)) {
            throw new NotesError("invalid_path", "The Notes directory must be absolute.");
        }
        this.#directory = directory;
        this.#trash = trash;
        this.#now = now;
    }

    async #locked(operation) {
        if (!this.#root) {
            await mkdir(this.#directory, { recursive: true });
        }
        const entry = await lstat(this.#directory);
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw new NotesError("unsafe_path", "The Notes library itself cannot be a symlink or junction.");
        }
        const canonical = await realpath(this.#directory);
        if (this.#root && canonical !== this.#root) throw new NotesError("unsafe_path", "The Notes library was redirected.");
        this.#root = canonical;
        return withLibraryLock(this.#root, () => operation(this.#root));
    }

    async #read(root, path) {
        const file = await readNoteFile(root, path);
        return { ...file, ...parseNote(file.raw), path };
    }

    async #scan(root) {
        const notes = [];
        const folders = [""];
        const warnings = [];
        async function walk(folder) {
            const directory = await resolveInside(root, folder);
            for (const entry of (await readdir(directory.path, { withFileTypes: true })).sort((a, b) => compareNames(a.name, b.name))) {
                const path = joinPath(folder, entry.name);
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
                        warnings.push({ path, code: error.code, message: error.message });
                    }
                }
            }
        }
        await walk("");

        // Oldest physical file keeps a copied ID; the path breaks equal-birthtime ties.
        notes.sort((a, b) => a.stats.birthtimeMs - b.stats.birthtimeMs || compareNames(a.path, b.path));
        const ids = new Set();
        for (let index = 0; index < notes.length; index++) {
            let note = notes[index];
            if (note.warning) {
                warnings.push({ path: note.path, ...note.warning });
                continue;
            }
            const birthtime = note.stats.birthtimeMs > 0 ? note.stats.birthtimeMs : note.stats.mtimeMs;
            const changes = {};
            if (!note.metadata.id) changes.id = adoptionId(note.path, birthtime);
            if (!note.metadata.created) changes.created = localTimestamp(birthtime);
            if (!note.metadata.updated) changes.updated = localTimestamp(note.stats.mtimeMs);
            if (!note.metadata.sessions) changes.sessions = [];
            let id = changes.id ?? note.metadata.id;
            if (ids.has(id)) {
                id = adoptionId(note.path, birthtime);
                while (ids.has(id)) id = newId(birthtime);
                changes.id = id;
            }
            ids.add(id);
            if (Object.keys(changes).length) {
                try {
                    const raw = serializeNote(note, note.body, changes);
                    await writeNoteFile(root, note.path, raw, note.version, { preserveTimes: note.stats });
                    notes[index] = await this.#read(root, note.path);
                } catch (error) {
                    if (!(error instanceof NotesError)) throw error;
                    warnings.push({ path: note.path, code: error.code, message: error.message });
                    notes[index] = undefined;
                }
            }
        }
        return { notes: notes.filter(Boolean), folders, warnings };
    }

    #find(snapshot, target) {
        requireString(target, "noteId");
        const path = ULID.test(target) ? undefined : requireNotePath(target);
        const note = ULID.test(target)
            ? snapshot.notes.find(note => note.metadata.id === target)
            : snapshot.notes.find(note => nameKey(note.path) === nameKey(path));
        if (!note) {
            const warning = snapshot.warnings.find(item => path && nameKey(item.path) === nameKey(path));
            if (warning) throw new NotesError(warning.code, warning.message);
            throw new NotesError("not_found", "The note was not found. Search again for its ID or relative path.");
        }
        if (!ULID.test(target) && snapshot.notes.filter(item => nameKey(item.path) === nameKey(note.path)).length > 1) {
            throw new NotesError("ambiguous_path", "Several notes have this name ignoring case. Use the note ID.");
        }
        return note;
    }

    async #folder(root, folder, create = false) {
        requireString(folder, "folder", { empty: true });
        const raw = folder.replaceAll("\\", "/");
        if (/^[A-Za-z]:|^\//.test(raw)) throw new NotesError("invalid_path", "Folders must be relative to Notes.");
        const parts = raw === "" ? [] : raw.split("/");
        const names = create ? parts.map(folderName) : relativePath(raw, { root: true }).split("/").filter(Boolean);
        let current = "";
        for (const name of names) {
            if (!visiblePath(name)) throw new NotesError("invalid_path", "Hidden and .assets folders are not note folders.");
            const parent = await resolveInside(root, current);
            const matches = (await readdir(parent.path)).filter(entry => nameKey(entry) === nameKey(name));
            if (matches.length > 1) throw new NotesError("ambiguous_path", "Several folders have this name ignoring case.");
            if (!matches.length) {
                if (!create) throw new NotesError("not_found", "The destination folder does not exist.");
                await mkdir(join(parent.path, name));
            }
            current = joinPath(current, matches[0] ?? name);
            const resolved = await resolveInside(root, current);
            if (!resolved.stats.isDirectory()) throw new NotesError("already_exists", "A file already uses this folder name.");
        }
        return current;
    }

    async #availablePath(root, folder, base, maxLength = 40) {
        const { path } = await resolveInside(root, folder);
        const taken = new Set((await readdir(path)).map(nameKey));
        for (let suffix = 1; ; suffix++) {
            const tail = suffix === 1 ? "" : `-${suffix}`;
            const stem = Array.from(base).slice(0, maxLength - tail.length).join("") + tail;
            if (!taken.has(nameKey(`${stem}.md`)) && !taken.has(nameKey(`${stem}.assets`))) {
                return joinPath(folder, `${stem}.md`);
            }
        }
    }

    async #assets(root, path) {
        const resolved = await resolveInside(root, assetPath(path), { missing: true });
        if (!resolved.stats) return undefined;
        if (!resolved.stats.isDirectory()) throw new NotesError("unsafe_path", "The note's .assets path is not a directory.");
        return assetPath(path);
    }

    async #relocate(root, note, destination, body, changes, preserveTimes) {
        requireVersion(note.version, (await readNoteFile(root, note.path)).version);
        const assets = await this.#assets(root, note.path);
        const newAssets = assetPath(destination);
        if (assets) {
            const original = await resolveInside(root, assets);
            let caseInsensitive = false;
            try {
                const variant = await resolveInside(root, joinPath(folderOf(assets), posix.basename(assets).toUpperCase()));
                caseInsensitive = variant.stats.dev === original.stats.dev && variant.stats.ino === original.stats.ino;
            } catch (error) {
                if (!(error instanceof NotesError) || error.code !== "not_found") throw error;
            }
            body = renameAssetLinks(body, posix.basename(assets), posix.basename(newAssets), { caseInsensitive });
        }
        const raw = note.warning ? body : serializeNote(note, body, changes);
        await writeNoteFile(root, destination, raw, null, { preserveTimes });
        let assetsMoved = false;
        try {
            if (assets) {
                const from = await resolveInside(root, assets);
                const to = await resolveInside(root, newAssets, { missing: true });
                if (to.stats) throw new NotesError("already_exists", "The destination assets directory already exists.");
                await rename(from.path, to.path);
                assetsMoved = true;
            }
            await removeNoteFile(root, note.path, note.version);
        } catch (error) {
            try {
                if (assetsMoved) {
                    const from = await resolveInside(root, newAssets);
                    const to = await resolveInside(root, assets, { missing: true });
                    if (to.stats) throw new NotesError("already_exists", "Cannot restore the original asset directory.");
                    await rename(from.path, to.path);
                }
                await removeNoteFile(root, destination, contentHash(raw));
            } catch (rollbackError) {
                throw new NotesError("move_incomplete", "The move could not be rolled back. Both paths were retained for recovery.", {
                    source: note.path, destination, cause: error.message, rollback: rollbackError.message,
                });
            }
            throw error;
        }
        return this.#read(root, destination);
    }

    async create({ body, folder = "" }, context) {
        assertContext(context);
        const content = newNoteBody(body);
        return this.#locked(async root => {
            const parent = await this.#folder(root, folder, true);
            const path = await this.#availablePath(root, parent, slug(titleOf(content)));
            const date = localTimestamp(this.#now());
            const metadata = {
                id: newId(new Date(date).getTime()),
                created: date,
                updated: date,
                created_by: context.actor,
                ...(context.project ? { project: context.project } : {}),
                ...(context.branch ? { branch: context.branch } : {}),
                session_id: context.sessionId,
                ...(context.sessionName ? { session_name: context.sessionName } : {}),
                sessions: [context.sessionId],
            };
            const raw = serializeNote(parseNote(""), content, metadata);
            await writeNoteFile(root, path, raw, null);
            return payload(await this.#read(root, path));
        });
    }

    async read(noteId) {
        return this.#locked(async root => payload(this.#find(await this.#scan(root), noteId)));
    }

    async search({ query = "", project, session, folder, limit = 50, offset = 0 } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
            throw new NotesError("invalid_request", "Use a limit from 1 to 100 and a non-negative integer offset.");
        }
        const { notes, warnings } = await this.list({ query, project, session, folder });
        return {
            notes: notes.slice(offset, offset + limit),
            total: notes.length,
            nextOffset: offset + limit < notes.length ? offset + limit : null,
            warnings,
        };
    }

    async list({ query = "", project, session, folder } = {}) {
        requireString(query, "query", { empty: true });
        for (const [name, value] of Object.entries({ project, session, folder })) {
            if (value !== undefined) requireString(value, name, { empty: name === "folder" });
        }
        return this.#locked(async root => {
            const snapshot = await this.#scan(root);
            const parent = folder === undefined ? undefined : await this.#folder(root, folder);
            const words = foldText(query).split(/\s+/).filter(Boolean);
            const matches = [];
            for (const note of snapshot.notes) {
                if (project !== undefined && note.metadata.project !== project) continue;
                if (session !== undefined && !note.metadata.sessions?.includes(session)) continue;
                if (parent !== undefined && !inFolder(folderOf(note.path), parent)) continue;
                const text = note.warning ? note.body : markdownText(note.body);
                const folded = foldText(text);
                const title = titleOf(note.body);
                if (!words.every(word => folded.includes(word) || foldText(title).includes(word))) continue;
                const match = words.length ? Math.max(0, folded.indexOf(words[0])) : 0;
                const start = Math.max(0, match - 40);
                const snippet = ((start ? "..." : "") + text.slice(start, start + 180) + (text.length > start + 180 ? "..." : ""))
                    .replace(/\s+([.,;:!?)\]])/g, "$1");
                matches.push({ ...summary(note), snippet, titleMatch: words.every(word => foldText(title).includes(word)) });
            }
            matches.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch)
                || Date.parse(b.lastEdited) - Date.parse(a.lastEdited) || compareNames(a.path, b.path));
            return {
                notes: matches.map(({ titleMatch, ...item }) => item),
                warnings: snapshot.warnings,
            };
        });
    }

    async #edit(noteId, expectedVersion, context, transform) {
        assertContext(context);
        return this.#locked(async root => {
            const note = this.#find(await this.#scan(root), noteId);
            requireVersion(expectedVersion, note.version);
            const body = transform(note);
            requireString(body, "body", { empty: true });
            if (body === note.body) return payload(note);
            const changes = {
                updated: localTimestamp(this.#now()),
                sessions: [...new Set([...(note.metadata.sessions ?? []), context.sessionId])],
            };
            const oldSlug = slug(titleOf(note.body));
            if (hasAutomaticName(note) && slug(titleOf(body)) !== oldSlug) {
                const destination = await this.#availablePath(root, folderOf(note.path), slug(titleOf(body)));
                return payload(await this.#relocate(root, note, destination, body, changes));
            }
            let raw;
            if (note.warning) {
                const repaired = parseNote(body);
                raw = repaired.warning ? body : serializeNote(repaired, repaired.body, {
                    id: repaired.metadata.id ?? adoptionId(note.path, note.stats.birthtimeMs || note.stats.mtimeMs),
                    created: repaired.metadata.created ?? localTimestamp(note.stats.birthtimeMs || note.stats.mtimeMs),
                    ...changes,
                    sessions: [...new Set([...(repaired.metadata.sessions ?? []), context.sessionId])],
                });
            } else {
                raw = serializeNote(note, body, changes);
            }
            await writeNoteFile(root, note.path, raw, note.version);
            return payload(await this.#read(root, note.path));
        });
    }

    async update(noteId, { body, find, replace, replaceAll = false, expectedVersion }, context) {
        const full = body !== undefined;
        if (full ? find !== undefined || replace !== undefined || replaceAll : find === undefined || replace === undefined) {
            throw new NotesError("invalid_request", "Provide either body, or find and replace, but not both.");
        }
        if (full) requireString(body, "body", { empty: true });
        else {
            requireString(find, "find");
            requireString(replace, "replace", { empty: true });
        }
        if (typeof replaceAll !== "boolean") throw new NotesError("invalid_request", "replaceAll must be a boolean.");
        return this.#edit(noteId, expectedVersion, context, note => {
            if (full) return body;
            const count = note.body.split(find).length - 1;
            if (!count) throw new NotesError("match_not_found", "The requested text was not found.");
            if (count > 1 && !replaceAll) throw new NotesError("ambiguous_match", "Text occurs more than once. Use a longer match or replaceAll.", { matches: count });
            return note.body.split(find).join(replace);
        });
    }

    async append(noteId, { text, expectedVersion }, context) {
        requireString(text, "text");
        return this.#edit(noteId, expectedVersion, context,
            note => note.body + (note.body === "" || note.body.endsWith("\n") ? "" : note.eol) + text);
    }

    async pin(noteId, pinned, expectedVersion) {
        if (typeof pinned !== "boolean") throw new NotesError("invalid_request", "pinned must be a boolean.");
        return this.#locked(async root => {
            const note = this.#find(await this.#scan(root), noteId);
            requireVersion(expectedVersion, note.version);
            if ((note.metadata.pinned === true) === pinned) return payload(note);
            const raw = serializeNote(note, note.body, { pinned: pinned ? true : undefined });
            await writeNoteFile(root, note.path, raw, note.version, { preserveTimes: note.stats });
            return payload(await this.#read(root, note.path));
        });
    }

    async move(noteId, { folder, expectedVersion }) {
        return this.#locked(async root => {
            const note = this.#find(await this.#scan(root), noteId);
            requireVersion(expectedVersion, note.version);
            const parent = await this.#folder(root, folder);
            if (parent === folderOf(note.path)) return payload(note);
            const automatic = hasAutomaticName(note);
            const destination = await this.#availablePath(root, parent,
                automatic ? slug(titleOf(note.body)) : posix.basename(note.path).slice(0, -3), automatic ? 40 : 240);
            return payload(await this.#relocate(root, note, destination, note.body, {}, note.stats));
        });
    }

    async #fingerprint(root, folder) {
        const items = [];
        async function walk(path) {
            const resolved = await resolveInside(root, path);
            const stats = resolved.stats;
            items.push([path, ...[stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map(value => value.toString())]);
            if (stats.isDirectory()) {
                for (const name of (await readdir(resolved.path)).sort(compareNames)) await walk(joinPath(path, name));
            }
        }
        await walk(folder);
        return contentHash(JSON.stringify(items));
    }

    async #deleteTargets(root, targets, confirmPermanent) {
        const deleted = [];
        const methods = new Set();
        for (const target of targets) {
            try {
                await target.verify();
                const resolved = await resolveInside(root, target.path);
                try {
                    await this.#trash(resolved.path);
                    if (await exists(resolved.path)) throw new NotesError("trash_unavailable", "The trash command left the item in place.");
                    methods.add("trash");
                } catch (error) {
                    if (!(error instanceof NotesError) || error.code !== "trash_unavailable") throw error;
                    if (!await exists(resolved.path)) {
                        throw new NotesError("delete_incomplete", "The OS reported an error after the item disappeared. Check the trash.", { path: target.path });
                    }
                    let approved;
                    try {
                        approved = await confirmPermanent?.(`The OS trash is unavailable. Permanently delete ${JSON.stringify(target.path)}${resolved.stats.isDirectory() ? " and ALL its contents" : ""}? This cannot be undone.`);
                    } catch {
                        throw new NotesError("trash_unavailable", "Permanent deletion requires a supported confirmation dialog and an explicit Yes.");
                    }
                    if (approved !== true) {
                        throw new NotesError("trash_unavailable", "Permanent deletion was not approved; the remaining item was kept.");
                    }
                    await target.verify();
                    const current = await resolveInside(root, target.path);
                    if (target.path === "") throw new NotesError("invalid_path", "The Notes root cannot be deleted.");
                    await rm(current.path, { recursive: current.stats.isDirectory(), force: false });
                    methods.add("permanent");
                }
                deleted.push(target.path);
            } catch (error) {
                throw new NotesError(error instanceof NotesError ? error.code : "delete_incomplete",
                    error instanceof NotesError ? error.message : "Deletion failed; some items may already have been removed.",
                    { ...(error.details ?? {}), deleted: [...deleted], remaining: target.path, cause: error.message });
            }
        }
        return { deleted, method: methods.size === 1 ? [...methods][0] : "mixed" };
    }

    async delete(noteId, { expectedVersion, confirmPermanent } = {}) {
        return this.#locked(async root => {
            const note = this.#find(await this.#scan(root), noteId);
            requireVersion(expectedVersion, note.version);
            const targets = [{
                path: note.path,
                verify: async () => requireVersion(note.version, (await readNoteFile(root, note.path)).version),
            }];
            const assets = await this.#assets(root, note.path);
            if (assets) {
                const version = await this.#fingerprint(root, assets);
                targets.push({ path: assets, verify: async () => requireVersion(version, await this.#fingerprint(root, assets)) });
            }
            return { id: note.metadata.id ?? null, ...await this.#deleteTargets(root, targets, confirmPermanent) };
        });
    }

    async folders() {
        return this.#locked(async root => {
            const snapshot = await this.#scan(root);
            const nodes = new Map(snapshot.folders.map(path => [path, {
                path, name: path ? posix.basename(path) : "Notes",
                count: snapshot.notes.filter(note => folderOf(note.path) === path).length,
                children: [],
            }]));
            for (const [path, node] of nodes) {
                if (path) {
                    try {
                        node.version = await this.#fingerprint(root, path);
                    } catch (error) {
                        if (!(error instanceof NotesError)) throw error;
                        node.version = null;
                        node.warning = { code: error.code, message: error.message };
                        snapshot.warnings.push({ path, ...node.warning });
                    }
                    nodes.get(folderOf(path)).children.push(node);
                }
            }
            for (const node of nodes.values()) node.children.sort((a, b) => compareNames(a.name, b.name));
            return { folders: nodes.get(""), warnings: snapshot.warnings };
        });
    }

    async createFolder(name, parent = "") {
        const cleaned = folderName(name);
        return this.#locked(async root => {
            const directory = await this.#folder(root, parent);
            const resolved = await resolveInside(root, directory);
            if ((await readdir(resolved.path)).some(entry => nameKey(entry) === nameKey(cleaned))) {
                throw new NotesError("already_exists", "A folder or file already uses this name ignoring case.");
            }
            const path = joinPath(directory, cleaned);
            await mkdir((await resolveInside(root, path, { missing: true })).path);
            return { path };
        });
    }

    async renameFolder(folder, name, expectedVersion) {
        const cleaned = folderName(name);
        return this.#locked(async root => {
            const path = await this.#folder(root, folder);
            if (!path) throw new NotesError("invalid_path", "The Notes root cannot be renamed.");
            requireVersion(expectedVersion, await this.#fingerprint(root, path));
            const parent = folderOf(path);
            const destination = joinPath(parent, cleaned);
            const currentName = posix.basename(path);
            const names = await readdir((await resolveInside(root, parent)).path);
            if (names.some(entry => entry !== currentName && nameKey(entry) === nameKey(cleaned))) {
                throw new NotesError("already_exists", "A folder or file already uses this name ignoring case.");
            }
            await rename((await resolveInside(root, path)).path, join(root, ...destination.split("/")));
            return { path: destination };
        });
    }

    async deleteFolder(folder, { expectedVersion, confirmDelete, confirmPermanent } = {}) {
        return this.#locked(async root => {
            const path = await this.#folder(root, folder);
            if (!path) throw new NotesError("invalid_path", "The Notes root cannot be deleted.");
            const snapshot = await this.#scan(root);
            requireVersion(expectedVersion, await this.#fingerprint(root, path));
            const count = snapshot.notes.filter(note => inFolder(folderOf(note.path), path)).length;
            if (await confirmDelete?.(`Delete ${JSON.stringify(path)}, its ${count} notes, and all other contents?`) !== true) {
                throw new NotesError("delete_cancelled", "Folder deletion was cancelled.");
            }
            return this.#deleteTargets(root, [{
                path,
                verify: async () => requireVersion(expectedVersion, await this.#fingerprint(root, path)),
            }], confirmPermanent);
        });
    }
}
