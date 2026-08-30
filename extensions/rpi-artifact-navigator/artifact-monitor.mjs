/**
 * Detect RPI artifact changes around successful tool executions.
 *
 * The extension snapshots only approved artifacts before a tool runs, compares
 * their content hashes after it succeeds, and reports created or updated files.
 * This avoids filesystem watchers and does not inspect tool names or arguments.
 */

import { discoverArtifactPaths, readArtifactFile, resolveWorkspaceRoot } from "./artifact-index.mjs";
import { classifyArtifact, extractTaskSlug } from "./artifact-parser.mjs";

const TYPE_PRIORITY = Object.freeze({
    "review-log": 60,
    changes: 50,
    "plan-critique": 45,
    plan: 40,
    "phase-details": 35,
    research: 30,
    unknown: 0,
});

export async function snapshotArtifacts(workspaceRoot) {
    const snapshot = new Map();
    for (const id of await discoverArtifactPaths(workspaceRoot)) {
        const file = await readArtifactFile(workspaceRoot, id);
        snapshot.set(id, {
            id,
            taskSlug: extractTaskSlug(id),
            type: classifyArtifact(id),
            modifiedAt: file.modifiedAt,
            sha256: file.sha256,
        });
    }
    return snapshot;
}

export function diffArtifactSnapshots(before, after) {
    const changes = [];
    for (const [id, artifact] of after) {
        const previous = before.get(id);
        if (previous === undefined) {
            changes.push({ ...artifact, operation: "create" });
        } else if (previous.sha256 !== artifact.sha256) {
            changes.push({ ...artifact, operation: "update" });
        }
    }
    return changes;
}

export function selectTaskChanges(changes) {
    const selected = new Map();
    for (const change of changes) {
        if (change.taskSlug === null) continue;
        const current = selected.get(change.taskSlug);
        if (current === undefined || compareChanges(current, change) < 0) {
            selected.set(change.taskSlug, change);
        }
    }
    return [...selected.values()].sort((a, b) => a.taskSlug.localeCompare(b.taskSlug));
}

function compareChanges(left, right) {
    const operation = Number(left.operation === "create") - Number(right.operation === "create");
    if (operation !== 0) return operation;
    const priority = (TYPE_PRIORITY[left.type] ?? 0) - (TYPE_PRIORITY[right.type] ?? 0);
    if (priority !== 0) return priority;
    const modified = Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt);
    if (modified !== 0) return modified;
    return left.id.localeCompare(right.id);
}

export function createArtifactChangeTracker({ onChanges, onError } = {}) {
    const baselines = new Map();

    async function resolveRoot(workingDirectory) {
        try {
            return await resolveWorkspaceRoot(workingDirectory);
        } catch (err) {
            onError?.(err);
            return null;
        }
    }

    return {
        async beforeTool(workingDirectory) {
            const root = await resolveRoot(workingDirectory);
            if (root === null) return;
            try {
                baselines.set(root, await snapshotArtifacts(root));
            } catch (err) {
                baselines.delete(root);
                onError?.(err);
            }
        },

        async afterTool(workingDirectory) {
            const root = await resolveRoot(workingDirectory);
            if (root === null) return [];
            const before = baselines.get(root);
            baselines.delete(root);
            if (before === undefined) return [];
            try {
                const changes = selectTaskChanges(diffArtifactSnapshots(before, await snapshotArtifacts(root)));
                if (changes.length > 0) await onChanges?.(changes, root);
                return changes;
            } catch (err) {
                onError?.(err);
                return [];
            }
        },
    };
}
