/**
 * Artifact path policy and discovery.
 *
 * Pure, dependency-free module. It resolves the workspace root, enforces the
 * read-only allowlist, and returns a deterministic index of RPI tracking
 * Markdown files. It never writes, executes, or reaches the network.
 *
 * The security boundary is filesystem read containment. Lexical prefix checks
 * are not sufficient, so every traversed path segment is `lstat`-checked and
 * symlinks are rejected, and every read is bound to a verified open file
 * descriptor whose identity is rechecked before and after the read.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Workspace-relative roots the navigator may read from. */
export const APPROVED_ROOTS = Object.freeze([
    ".copilot-tracking/research",
    ".copilot-tracking/plans",
    ".copilot-tracking/details",
    ".copilot-tracking/changes",
    ".copilot-tracking/reviews/plans",
    ".copilot-tracking/reviews/logs",
]);

/** Hard resource ceilings. Limits fail explicitly instead of truncating. */
export const LIMITS = Object.freeze({
    maxArtifacts: 200,
    maxFileBytes: 1024 * 1024,
    maxHeadings: 500,
    maxResponseBytes: Math.floor(1.5 * 1024 * 1024),
});

/** Closed error-code set shared by the provider, server, and domain layer. */
export const ERROR_CODES = Object.freeze({
    workspaceUnavailable: "workspace_unavailable",
    canvasUnsupported: "canvas_unsupported",
    artifactIdInvalid: "artifact_id_invalid",
    artifactNotAllowed: "artifact_not_allowed",
    artifactNotFound: "artifact_not_found",
    artifactNotFile: "artifact_not_file",
    artifactChanged: "artifact_changed",
    artifactLimitExceeded: "artifact_limit_exceeded",
    artifactTooLarge: "artifact_too_large",
    headingLimitExceeded: "heading_limit_exceeded",
    responseTooLarge: "response_too_large",
    requestUnauthorized: "request_unauthorized",
    requestInvalid: "request_invalid",
    serverClosed: "server_closed",
});

/**
 * Domain error carrying one of the closed `ERROR_CODES` values. Messages never
 * include absolute paths so a rejected request cannot disclose the filesystem.
 */
export class ArtifactError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "ArtifactError";
        this.code = code;
    }
}

/** Convert a native path to a normalized, forward-slash workspace-relative id. */
function toArtifactId(workspaceRoot, absolutePath) {
    return relative(workspaceRoot, absolutePath).split(sep).join("/");
}

/**
 * Validate a caller-supplied artifact id.
 *
 * Rejects absolute paths, Windows drive and UNC forms, backslashes, `.` and
 * `..` segments, empty segments, NUL bytes, and non-Markdown suffixes before
 * any filesystem call happens.
 */
export function normalizeArtifactId(artifactId) {
    if (typeof artifactId !== "string" || artifactId.length === 0) {
        throw new ArtifactError(ERROR_CODES.artifactIdInvalid, "artifactId must be a non-empty string");
    }
    if (artifactId.includes("\0")) {
        throw new ArtifactError(ERROR_CODES.artifactIdInvalid, "artifactId must not contain NUL bytes");
    }
    if (artifactId.includes("\\")) {
        throw new ArtifactError(ERROR_CODES.artifactIdInvalid, "artifactId must use forward slashes");
    }
    if (artifactId.startsWith("/") || /^[A-Za-z]:/.test(artifactId)) {
        throw new ArtifactError(ERROR_CODES.artifactIdInvalid, "artifactId must be workspace-relative");
    }

    const segments = artifactId.split("/");
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new ArtifactError(ERROR_CODES.artifactIdInvalid, "artifactId must not contain empty or relative segments");
        }
    }
    if (!artifactId.endsWith(".md")) {
        throw new ArtifactError(ERROR_CODES.artifactNotAllowed, "Only Markdown artifacts are readable");
    }
    if (!APPROVED_ROOTS.some((root) => artifactId === root || artifactId.startsWith(`${root}/`))) {
        throw new ArtifactError(ERROR_CODES.artifactNotAllowed, "artifactId is outside the approved tracking roots");
    }
    return artifactId;
}

/**
 * Resolve the real workspace root.
 *
 * `realpath` is applied once here so that later containment checks compare
 * fully resolved paths and cannot be defeated by a symlinked workspace prefix.
 */
export async function resolveWorkspaceRoot(workspacePath) {
    if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
        throw new ArtifactError(ERROR_CODES.workspaceUnavailable, "No workspace path is available");
    }
    try {
        return await realpath(resolve(workspacePath));
    } catch {
        throw new ArtifactError(ERROR_CODES.workspaceUnavailable, "The workspace path could not be resolved");
    }
}

/** True when `candidate` is `root` itself or strictly underneath it. */
function isContained(root, candidate) {
    const rel = relative(root, candidate);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Walk each segment from the workspace root to the target and reject any
 * segment that is a symlink. This closes the gap that a single realpath check
 * on the final path would leave open, because it also rejects a symlinked
 * intermediate directory that resolves back inside the workspace.
 */
async function assertNoSymlinkSegments(workspaceRoot, relativePath) {
    let current = workspaceRoot;
    for (const segment of relativePath.split("/")) {
        current = join(current, segment);
        let stats;
        try {
            stats = await lstat(current);
        } catch {
            throw new ArtifactError(ERROR_CODES.artifactNotFound, "The requested artifact does not exist");
        }
        if (stats.isSymbolicLink()) {
            throw new ArtifactError(ERROR_CODES.artifactNotAllowed, "Symlinked path segments are not readable");
        }
    }
}

/** Stable identity tuple used for the pre-open and post-open comparison. */
function identityOf(stats) {
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

/**
 * Read one allowed artifact.
 *
 * The file is opened read-only, verified through `fstat` on the open
 * descriptor, and its identity is compared before and after the read so a file
 * swapped between check and use is reported as `artifact_changed` rather than
 * silently returned.
 */
export async function readArtifactFile(workspaceRoot, artifactId) {
    const normalizedId = normalizeArtifactId(artifactId);
    const absolutePath = resolve(workspaceRoot, normalizedId);
    if (!isContained(workspaceRoot, absolutePath) || absolutePath === workspaceRoot) {
        throw new ArtifactError(ERROR_CODES.artifactNotAllowed, "The requested artifact escapes the workspace");
    }

    await assertNoSymlinkSegments(workspaceRoot, normalizedId);

    let handle;
    try {
        handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
        if (err && (err.code === "ELOOP" || err.code === "EMLINK")) {
            throw new ArtifactError(ERROR_CODES.artifactNotAllowed, "Symlinked artifacts are not readable");
        }
        if (err && err.code === "EISDIR") {
            throw new ArtifactError(ERROR_CODES.artifactNotFile, "The requested artifact is not a regular file");
        }
        throw new ArtifactError(ERROR_CODES.artifactNotFound, "The requested artifact does not exist");
    }

    try {
        const before = await handle.stat();
        if (!before.isFile()) {
            throw new ArtifactError(ERROR_CODES.artifactNotFile, "The requested artifact is not a regular file");
        }
        if (before.size > LIMITS.maxFileBytes) {
            throw new ArtifactError(ERROR_CODES.artifactTooLarge, "The requested artifact exceeds the size limit");
        }

        const buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < before.size) {
            const { bytesRead } = await handle.read(buffer, offset, before.size - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset !== before.size) {
            throw new ArtifactError(ERROR_CODES.artifactChanged, "The artifact changed while it was being read");
        }

        const after = await handle.stat();
        if (identityOf(before) !== identityOf(after)) {
            throw new ArtifactError(ERROR_CODES.artifactChanged, "The artifact changed while it was being read");
        }

        // A replaced file keeps its path but not its inode. Compare the current
        // path identity against the descriptor we actually read from.
        let currentStats;
        try {
            currentStats = await lstat(absolutePath);
        } catch {
            throw new ArtifactError(ERROR_CODES.artifactChanged, "The artifact changed while it was being read");
        }
        if (currentStats.isSymbolicLink() || currentStats.dev !== after.dev || currentStats.ino !== after.ino) {
            throw new ArtifactError(ERROR_CODES.artifactChanged, "The artifact changed while it was being read");
        }

        const source = buffer.toString("utf8");
        return {
            id: normalizedId,
            source,
            sizeBytes: before.size,
            modifiedAt: new Date(before.mtimeMs).toISOString(),
            sha256: createHash("sha256").update(buffer).digest("hex"),
        };
    } finally {
        await handle.close();
    }
}

/** Recursively collect allowed Markdown files beneath one approved root. */
async function collectFromRoot(workspaceRoot, rootRelativePath, found) {
    const absoluteRoot = resolve(workspaceRoot, rootRelativePath);
    if (!isContained(workspaceRoot, absoluteRoot)) return;

    let rootStats;
    try {
        rootStats = await lstat(absoluteRoot);
    } catch {
        return;
    }
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return;

    const queue = [absoluteRoot];
    while (queue.length > 0) {
        const directory = queue.shift();
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const dirent of entries) {
            const childPath = join(directory, dirent.name);
            if (dirent.isSymbolicLink()) continue;
            if (dirent.isDirectory()) {
                queue.push(childPath);
                continue;
            }
            if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
            found.push(toArtifactId(workspaceRoot, childPath));
        }
    }
}

/**
 * Discover every allowed artifact path.
 *
 * A missing `.copilot-tracking` tree yields an empty list rather than an error;
 * only direct requests for disallowed or missing artifacts fail.
 */
export async function discoverArtifactPaths(workspaceRoot) {
    const found = [];
    for (const root of APPROVED_ROOTS) {
        await collectFromRoot(workspaceRoot, root, found);
    }
    const unique = [...new Set(found)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (unique.length > LIMITS.maxArtifacts) {
        throw new ArtifactError(
            ERROR_CODES.artifactLimitExceeded,
            `The workspace contains more than ${LIMITS.maxArtifacts} tracking artifacts`,
        );
    }
    return unique;
}

/** Assert that a value serializes within the response ceiling. */
export function assertResponseWithinLimit(value) {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized ?? "", "utf8");
    if (bytes > LIMITS.maxResponseBytes) {
        throw new ArtifactError(ERROR_CODES.responseTooLarge, "The response exceeds the serialized size limit");
    }
    return serialized;
}
