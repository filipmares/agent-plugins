/**
 * RPI Artifact Navigator canvas provider.
 *
 * Declares one read-only canvas and exactly three agent-callable actions.
 * Files on disk stay authoritative; a canvas instance holds only transient
 * rendering state, so reopening or reloading always rehydrates from disk.
 *
 * Provider/server interface consumed here and implemented by `server.mjs`:
 *
 *   createNavigatorServer({ workspaceRoot, title, log }) -> Promise<NavigatorServer>
 *   NavigatorServer = {
 *     origin: string,          // bound loopback origin
 *     basePath: string,        // per-instance capability path, secret
 *     url: string,             // URL handed to the host iframe
 *     closed: boolean,
 *     notifyRefresh(): number, // ephemeral invalidation; returns streams notified
 *     close(): Promise<void>,  // invalidate capability, end streams, free port
 *   }
 *
 * Action results are returned as raw JSON-compatible values. They are never
 * stringified and never wrapped in a success envelope.
 */

import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { ArtifactError, ERROR_CODES, resolveWorkspaceRoot } from "./artifact-index.mjs";
import { buildArtifactList, buildArtifactPayload, createNavigatorServer } from "./server.mjs";

const CANVAS_ID = "rpi-artifact-navigator";
const CANVAS_TITLE = "RPI Artifact Navigator";

const EMPTY_INPUT_SCHEMA = Object.freeze({ type: "object", additionalProperties: false });
const ARTIFACT_INPUT_SCHEMA = Object.freeze({
    type: "object",
    required: ["artifactId"],
    additionalProperties: false,
    properties: {
        artifactId: {
            type: "string",
            minLength: 1,
            description: "Normalized workspace-relative path of the artifact, as returned by list_rpi_artifacts.",
        },
    },
});

/** Live per-instance servers, keyed by canvas instance id. */
const instances = new Map();

/**
 * In-flight server creations, keyed by canvas instance id.
 *
 * `openNavigator` awaits between checking the registry and writing to it, so
 * two concurrent opens for one instance would each observe an empty slot and
 * each bind a server, and the loser would be overwritten while still listening.
 * Publishing the creation promise before the first await makes the second
 * caller join the same creation instead of starting a rival one, so exactly one
 * server ever exists per instance and `onClose` can always release it.
 */
const pendingInstances = new Map();

let session;

function log(message, options) {
    void session?.log(`[${CANVAS_ID}] ${message}`, options)?.catch?.(() => {});
}

/** Convert any thrown value into a closed-taxonomy `CanvasError`. */
function toCanvasError(err) {
    if (err instanceof CanvasError) return err;
    if (err instanceof ArtifactError) return new CanvasError(err.code, err.message);
    return new CanvasError(ERROR_CODES.requestInvalid, "The canvas request could not be processed");
}

/**
 * Resolve the workspace for a request.
 *
 * The runtime's per-request session context is preferred because it reflects
 * the session the canvas actually belongs to; the joined session path is the
 * fallback.
 */
async function resolveWorkspace(ctx) {
    const candidate = ctx?.session?.workingDirectory ?? session?.workspacePath;
    return resolveWorkspaceRoot(candidate);
}

/** Fail closed when the host does not report canvas rendering support. */
function assertCanvasSupported(ctx) {
    const capabilities = ctx?.host?.capabilities;
    if (capabilities !== undefined && capabilities.canvases === false) {
        throw new CanvasError(
            ERROR_CODES.canvasUnsupported,
            "This host does not support canvas rendering. Open the tracking Markdown files directly instead.",
        );
    }
}

/** Reject any input that the declared schema does not allow. */
function requireEmptyInput(input) {
    if (input === undefined || input === null) return;
    if (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) {
        throw new CanvasError(ERROR_CODES.requestInvalid, "This action does not accept input");
    }
}

function requireArtifactInput(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new CanvasError(ERROR_CODES.requestInvalid, "artifactId is required");
    }
    const keys = Object.keys(input);
    if (keys.length !== 1 || keys[0] !== "artifactId") {
        throw new CanvasError(ERROR_CODES.requestInvalid, "artifactId is the only accepted property");
    }
    if (typeof input.artifactId !== "string" || input.artifactId.length === 0) {
        throw new CanvasError(ERROR_CODES.artifactIdInvalid, "artifactId must be a non-empty string");
    }
    return input.artifactId;
}

export async function listRpiArtifacts(ctx) {
    try {
        requireEmptyInput(ctx?.input);
        return await buildArtifactList(await resolveWorkspace(ctx));
    } catch (err) {
        throw toCanvasError(err);
    }
}

export async function getRpiArtifact(ctx) {
    try {
        const artifactId = requireArtifactInput(ctx?.input);
        return await buildArtifactPayload(await resolveWorkspace(ctx), artifactId);
    } catch (err) {
        throw toCanvasError(err);
    }
}

export async function refreshRpiArtifacts(ctx) {
    try {
        requireEmptyInput(ctx?.input);
        const payload = await buildArtifactList(await resolveWorkspace(ctx));

        // Refresh publishes only an ephemeral invalidation to live instances.
        // It never writes a file or any durable state.
        let refreshedInstances = 0;
        for (const server of instances.values()) {
            if (server.closed) continue;
            server.notifyRefresh();
            refreshedInstances += 1;
        }
        return { ...payload, refreshedInstances };
    } catch (err) {
        throw toCanvasError(err);
    }
}

/** Open, or focus, the canvas instance. Re-opening never creates a second server. */
export async function openNavigator(ctx) {
    try {
        assertCanvasSupported(ctx);
        const instanceId = ctx.instanceId;

        const existing = instances.get(instanceId);
        if (existing !== undefined && !existing.closed) {
            return { url: existing.url, title: CANVAS_TITLE, status: "Reusing the open navigator instance" };
        }

        const inFlight = pendingInstances.get(instanceId);
        if (inFlight !== undefined) {
            const joined = await inFlight;
            return { url: joined.url, title: CANVAS_TITLE, status: "Reusing the open navigator instance" };
        }

        const creation = (async () => {
            const workspaceRoot = await resolveWorkspace(ctx);
            const server = await createNavigatorServer({ workspaceRoot, title: CANVAS_TITLE, log });
            instances.set(instanceId, server);
            return server;
        })();
        pendingInstances.set(instanceId, creation);

        let server;
        try {
            server = await creation;
        } finally {
            pendingInstances.delete(instanceId);
        }

        log("Opened a navigator instance");
        return { url: server.url, title: CANVAS_TITLE, status: "Reading tracking artifacts from disk" };
    } catch (err) {
        throw toCanvasError(err);
    }
}

/** Release exactly the server bound to the closing instance. */
export async function closeNavigator(ctx) {
    // A close racing an open must still release the server that open produces,
    // otherwise the orphan keeps serving with a valid capability.
    const inFlight = pendingInstances.get(ctx.instanceId);
    if (inFlight !== undefined) {
        await inFlight.catch(() => undefined);
    }
    const server = instances.get(ctx.instanceId);
    if (server === undefined) return;
    instances.delete(ctx.instanceId);
    await server.close();
    log("Closed a navigator instance");
}

export const canvasDeclaration = createCanvas({
    id: CANVAS_ID,
    displayName: CANVAS_TITLE,
    description: "Browse read-only RPI tracking artifacts, their metadata, and their heading outlines.",
    inputSchema: EMPTY_INPUT_SCHEMA,
    actions: [
        {
            name: "list_rpi_artifacts",
            description: "List every RPI tracking artifact in the approved workspace roots.",
            inputSchema: EMPTY_INPUT_SCHEMA,
            handler: listRpiArtifacts,
        },
        {
            name: "get_rpi_artifact",
            description: "Read one RPI tracking artifact, including its metadata, heading outline, and source text.",
            inputSchema: ARTIFACT_INPUT_SCHEMA,
            handler: getRpiArtifact,
        },
        {
            name: "refresh_rpi_artifacts",
            description: "Re-read the approved roots from disk and refresh any open navigator panels.",
            inputSchema: EMPTY_INPUT_SCHEMA,
            handler: refreshRpiArtifacts,
        },
    ],
    open: openNavigator,
    onClose: closeNavigator,
});

/** Release every instance when the extension process is shut down or reloaded. */
async function releaseAllInstances() {
    const pending = [...pendingInstances.values()];
    pendingInstances.clear();
    await Promise.allSettled(pending);
    const servers = [...instances.values()];
    instances.clear();
    await Promise.allSettled(servers.map((server) => server.close()));
}

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        void releaseAllInstances().finally(() => process.exit(0));
    });
}

session = await joinSession({ canvases: [canvasDeclaration] });
