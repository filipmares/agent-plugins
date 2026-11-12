import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contentHash } from "./note-format.mjs";
import { NotesError, requireString } from "./errors.mjs";

export const MAX_NOTE_BYTES = 8 * 1024 * 1024;
const LOCK_NAME = ".notes-write.lock";
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const TRANSIENT_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

// Windows sync clients, antivirus and indexers briefly hold files that were just written or released, so create,
// rename and unlink can fail with these codes and then succeed. Elsewhere they are genuine permission errors.
export function isTransientFsError(error, platform = process.platform) {
    return platform === "win32" && TRANSIENT_CODES.has(error?.code);
}

export async function retryTransient(operation, { platform = process.platform, delays = TRANSIENT_DELAYS_MS } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= delays.length || !isTransientFsError(error, platform)) throw error;
            await delay(delays[attempt]);
        }
    }
}

export function relativePath(value, { root = false } = {}) {
    requireString(value, "Path", { empty: root });
    const path = value.replaceAll("\\", "/");
    if (path === "" && root) return "";
    if (/^[A-Za-z]:|^\//.test(path) || /[<>:"|?*\x00-\x1f]/.test(path)
        || path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) {
        throw new NotesError("invalid_path", "Use a relative path without traversal, drive letters, or reserved characters.");
    }
    return path;
}

export function visiblePath(path) {
    return !path.split("/").some(part => part.startsWith(".") || /\.assets$/i.test(part));
}

export function isInside(root, target) {
    const path = relative(root, target);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function resolveInside(root, path = "", { missing = false } = {}) {
    const normalized = relativePath(path, { root: true });
    const rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || relative(root, await realpath(root)) !== "") {
        throw new NotesError("unsafe_path", "The Notes directory was replaced or redirected.");
    }
    let target = root;
    let stats = rootStat;
    const parts = normalized ? normalized.split("/") : [];
    for (let i = 0; i < parts.length; i++) {
        target = join(target, parts[i]);
        try {
            stats = await lstat(target, { bigint: true });
        } catch (error) {
            if (error.code === "ENOENT" && missing && i === parts.length - 1) return { path: target };
            if (error.code === "ENOENT") throw new NotesError("not_found", "The note or folder no longer exists.");
            throw error;
        }
        if (stats.isSymbolicLink() || (!stats.isDirectory() && i < parts.length - 1)) {
            throw new NotesError("unsafe_path", "Symlinks and non-directory path components are not supported.");
        }
    }
    if (!isInside(root, await realpath(target))) {
        throw new NotesError("unsafe_path", "The path leaves the Notes directory.");
    }
    return { path: target, stats };
}

function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a, b) {
    return sameIdentity(a, b) && a.size === b.size && a.nlink === b.nlink
        && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export async function readLibraryFile(root, path) {
    const target = await resolveInside(root, path);
    if (!target.stats.isFile() || target.stats.nlink !== 1n) {
        throw new NotesError("unsafe_path", "Notes must be regular files without hard links.");
    }
    const handle = await open(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const before = await handle.stat({ bigint: true });
        // Windows directory-entry timestamps can lag descriptor timestamps after a write.
        if (!sameIdentity(before, target.stats) || !before.isFile() || before.nlink !== 1n) {
            throw new NotesError("conflict", "The note changed while opening it.");
        }
        if (before.size > BigInt(MAX_NOTE_BYTES)) throw new NotesError("note_too_large", "A note must not exceed 8 MiB.");
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const resolved = await resolveInside(root, path);
        if (!sameFile(before, after) || !sameIdentity(after, resolved.stats) || BigInt(length) !== before.size) {
            throw new NotesError("conflict", "The note changed while reading it.");
        }
        const bytes = buffer.subarray(0, length);
        return { bytes, stats: await handle.stat(), version: contentHash(bytes) };
    } finally {
        await handle.close();
    }
}

export async function readNoteFile(root, path) {
    const { bytes, ...file } = await readLibraryFile(root, path);
    try {
        return { ...file, raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
        throw new NotesError("invalid_encoding", "Notes supports UTF-8 Markdown; this file was not modified.");
    }
}

export function requireVersion(expected, actual) {
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
        throw new NotesError("invalid_request", "expectedVersion must be the content version returned by read or search.");
    }
    if (expected !== actual) throw new NotesError("conflict", "Changed elsewhere. Read the note again before saving.");
}

async function removeTemporary(path) {
    try { await retryTransient(() => unlink(path)); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Callers hold the library lock. The hash check also catches changes by external editors.
export async function writeNoteFile(root, path, raw, expectedVersion, { preserveTimes } = {}) {
    if (Buffer.byteLength(raw, "utf8") > MAX_NOTE_BYTES) {
        throw new NotesError("note_too_large", "A note, including frontmatter, must not exceed 8 MiB.");
    }
    const target = await resolveInside(root, path, { missing: expectedVersion === null });
    if (expectedVersion === null && target.stats) throw new NotesError("already_exists", "A file already uses this name.");
    const temporary = join(dirname(target.path), `.${basename(target.path)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", target.stats ? Number(target.stats.mode & 0o777n) : 0o600);
    try {
        try {
            const temporaryPath = relative(root, temporary).split(sep).join("/");
            const opened = await handle.stat({ bigint: true });
            const resolved = await resolveInside(root, temporaryPath);
            if (!sameIdentity(opened, resolved.stats)) throw new NotesError("unsafe_path", "The temporary write target was redirected.");
            await handle.writeFile(raw, "utf8");
            if (preserveTimes) await handle.utimes(preserveTimes.atimeMs / 1000, preserveTimes.mtimeMs / 1000);
            await handle.sync();
            if (!sameIdentity(opened, (await resolveInside(root, temporaryPath)).stats)) {
                throw new NotesError("unsafe_path", "The temporary file was replaced while saving.");
            }
        } finally {
            await handle.close();
        }
        await resolveInside(root, path, { missing: expectedVersion === null });
        if (expectedVersion === null) {
            // link is a no-clobber publication; unlike rename it cannot replace an external file.
            await retryTransient(() => link(temporary, target.path));
        } else {
            // Re-checked on every attempt, so a retry never replaces a note that changed in the meantime.
            await retryTransient(async () => {
                requireVersion(expectedVersion, (await readNoteFile(root, path)).version);
                await rename(temporary, target.path);
            });
        }
    } finally {
        await removeTemporary(temporary);
    }
}

export async function removeNoteFile(root, path, expectedVersion) {
    // Re-checked on every attempt, so a retry never deletes a note that changed in the meantime.
    await retryTransient(async () => {
        requireVersion(expectedVersion, (await readNoteFile(root, path)).version);
        await unlink((await resolveInside(root, path)).path);
    });
}

export async function withLibraryLock(root, operation, { timeoutMs = 30000 } = {}) {
    await resolveInside(root);
    const lockPath = join(root, LOCK_NAME);
    const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
    const deadline = Date.now() + timeoutMs;
    let handle;
    while (!handle) {
        try {
            handle = await retryTransient(() => open(lockPath, "wx", 0o600));
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            if (Date.now() >= deadline) {
                throw new NotesError("library_busy",
                    "Another Notes writer holds .notes-write.lock. Retry; after a crash, remove that lock only when all Notes processes are stopped.");
            }
            await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        }
    }
    try {
        await handle.writeFile(owner);
        return await operation();
    } finally {
        await handle.close();
        // A lock left behind blocks every writer, so release is retried as a whole, ownership check included.
        await retryTransient(async () => {
            const lock = await lstat(lockPath);
            if (lock.isSymbolicLink() || await readFile(lockPath, "utf8") !== owner) {
                throw new NotesError("lock_changed", "The Notes write lock changed unexpectedly; it was not removed.");
            }
            await unlink(lockPath);
        });
    }
}
