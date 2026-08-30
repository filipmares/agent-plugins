/**
 * Per-instance loopback server for the navigator UI.
 *
 * The canvas iframe has no privileged host bridge, so the UI is reached over
 * ordinary HTTP. The trust model is:
 *
 * - bind to `127.0.0.1` on an ephemeral port, never a routable interface
 * - every URL is namespaced by an unguessable 256-bit per-instance capability
 *   carried in the path; the capability never appears in logs or error bodies
 * - the `Host` header must match the bound loopback authority exactly
 * - an `Origin` header, when present, must match the bound loopback origin;
 *   CORS is never granted and preflight is refused
 * - only the named routes and methods below are served
 * - responses are `no-store`, `nosniff`, `no-referrer`, and CSP-restricted
 * - closing the instance invalidates the capability and ends live responses
 *
 * This module implements the `NavigatorServer` interface owned by
 * `extension.mjs` and depends only on the pure artifact model.
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
    ArtifactError,
    ERROR_CODES,
    assertResponseWithinLimit,
    discoverArtifactPaths,
    readArtifactFile,
} from "./artifact-index.mjs";
import { buildArtifactDocument, buildArtifactSummary } from "./artifact-parser.mjs";
import { NAVIGATOR_SCRIPT, NAVIGATOR_STYLES, renderNavigatorHtml } from "./renderer.mjs";

const CONTENT_SECURITY_POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
].join("; ");

/** HTTP status for each closed error code. */
const STATUS_BY_CODE = Object.freeze({
    [ERROR_CODES.requestUnauthorized]: 404,
    [ERROR_CODES.requestInvalid]: 400,
    [ERROR_CODES.artifactIdInvalid]: 400,
    [ERROR_CODES.artifactNotAllowed]: 403,
    [ERROR_CODES.artifactNotFound]: 404,
    [ERROR_CODES.artifactNotFile]: 400,
    [ERROR_CODES.artifactChanged]: 409,
    [ERROR_CODES.artifactLimitExceeded]: 413,
    [ERROR_CODES.artifactTooLarge]: 413,
    [ERROR_CODES.headingLimitExceeded]: 413,
    [ERROR_CODES.responseTooLarge]: 413,
    [ERROR_CODES.workspaceUnavailable]: 503,
    [ERROR_CODES.serverClosed]: 503,
});

/**
 * Build the summary list for the approved roots.
 *
 * Artifacts that disappear or are replaced between discovery and read are
 * skipped, because the index is a best-effort projection of files that may
 * change at any time. Every other failure propagates. A resource ceiling in
 * particular must fail explicitly rather than truncate, so an artifact the
 * navigator cannot process is never quietly absent from a list that presents
 * itself as complete.
 */
const TRANSIENT_LIST_ERRORS = new Set([ERROR_CODES.artifactNotFound, ERROR_CODES.artifactChanged]);

export async function buildArtifactList(workspaceRoot) {
    const ids = await discoverArtifactPaths(workspaceRoot);
    const artifacts = [];
    for (const id of ids) {
        try {
            artifacts.push(buildArtifactSummary(await readArtifactFile(workspaceRoot, id)));
        } catch (err) {
            if (err instanceof ArtifactError && TRANSIENT_LIST_ERRORS.has(err.code)) continue;
            throw err;
        }
    }
    artifacts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const payload = { artifacts, count: artifacts.length };
    assertResponseWithinLimit(payload);
    return payload;
}

/** Build the full document payload for one artifact. */
export async function buildArtifactPayload(workspaceRoot, artifactId) {
    const payload = { artifact: buildArtifactDocument(await readArtifactFile(workspaceRoot, artifactId)) };
    assertResponseWithinLimit(payload);
    return payload;
}

function applySecurityHeaders(res, contentType) {
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Vary", "Origin");
}

function sendText(res, status, contentType, body) {
    applySecurityHeaders(res, contentType);
    res.statusCode = status;
    res.end(body);
}

function sendJson(res, status, value) {
    sendText(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

/** Send a closed-taxonomy error without leaking paths or the capability. */
function sendError(res, err) {
    const code = err instanceof ArtifactError ? err.code : ERROR_CODES.requestInvalid;
    const message = err instanceof ArtifactError ? err.message : "The request could not be processed";
    sendJson(res, STATUS_BY_CODE[code] ?? 400, { error: code, message });
}

/**
 * Create the loopback server for one canvas instance.
 *
 * `log` is optional and receives operational messages only; it is never given
 * the capability token or an artifact path.
 */
export async function createNavigatorServer({ workspaceRoot, title, selectedArtifactId: initialArtifactId, log } = {}) {
    if (typeof workspaceRoot !== "string" || workspaceRoot === "") {
        throw new ArtifactError(ERROR_CODES.workspaceUnavailable, "No workspace path is available");
    }

    const token = randomBytes(32).toString("hex");
    const basePath = `/${token}`;
    const html = renderNavigatorHtml({ title });
    const liveStreams = new Set();
    let selectedArtifactId = null;
    let targetRevision = 0;
    let closed = false;
    let authority = "";
    let origin = "";

    if (initialArtifactId !== undefined) {
        await buildArtifactPayload(workspaceRoot, initialArtifactId);
        selectedArtifactId = initialArtifactId;
        targetRevision = 1;
    }

    async function buildNavigatorList() {
        const payload = { ...(await buildArtifactList(workspaceRoot)), selectedArtifactId, targetRevision };
        assertResponseWithinLimit(payload);
        return payload;
    }

    const handler = async (req, res) => {
        try {
            if (closed) {
                throw new ArtifactError(ERROR_CODES.serverClosed, "The navigator instance is closed");
            }

            // Preflight is never answered affirmatively; CORS is not granted.
            if (req.method === "OPTIONS") {
                applySecurityHeaders(res, "application/json; charset=utf-8");
                res.setHeader("Allow", "GET, POST");
                res.statusCode = 405;
                res.end(JSON.stringify({ error: ERROR_CODES.requestInvalid, message: "Method not allowed" }));
                return;
            }

            if (req.headers.host !== authority) {
                throw new ArtifactError(ERROR_CODES.requestUnauthorized, "Not found");
            }
            const requestOrigin = req.headers.origin;
            if (requestOrigin !== undefined && requestOrigin !== origin) {
                throw new ArtifactError(ERROR_CODES.requestUnauthorized, "Not found");
            }

            const url = new URL(req.url ?? "/", origin);
            if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
                throw new ArtifactError(ERROR_CODES.requestUnauthorized, "Not found");
            }
            const route = url.pathname.slice(basePath.length) || "/";

            if (req.method === "GET") {
                if (route === "/") {
                    sendText(res, 200, "text/html; charset=utf-8", html);
                    return;
                }
                if (route === "/app.css") {
                    sendText(res, 200, "text/css; charset=utf-8", NAVIGATOR_STYLES);
                    return;
                }
                if (route === "/app.js") {
                    sendText(res, 200, "text/javascript; charset=utf-8", NAVIGATOR_SCRIPT);
                    return;
                }
                if (route === "/api/artifacts") {
                    sendJson(res, 200, await buildNavigatorList());
                    return;
                }
                if (route === "/api/artifact") {
                    const artifactId = url.searchParams.get("artifactId");
                    if (artifactId === null) {
                        throw new ArtifactError(ERROR_CODES.requestInvalid, "artifactId is required");
                    }
                    sendJson(res, 200, await buildArtifactPayload(workspaceRoot, artifactId));
                    return;
                }
                if (route === "/api/events") {
                    applySecurityHeaders(res, "text/event-stream; charset=utf-8");
                    res.statusCode = 200;
                    res.write(": connected\n\n");
                    liveStreams.add(res);
                    res.on("close", () => liveStreams.delete(res));
                    return;
                }
            }

            if (req.method === "POST" && route === "/api/refresh") {
                sendJson(res, 200, await buildNavigatorList());
                return;
            }

            throw new ArtifactError(ERROR_CODES.requestUnauthorized, "Not found");
        } catch (err) {
            if (!(err instanceof ArtifactError)) {
                log?.("The navigator request failed unexpectedly", { level: "error" });
            }
            sendError(res, err);
        }
    };

    const server = createServer((req, res) => {
        void handler(req, res);
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    authority = `127.0.0.1:${port}`;
    origin = `http://${authority}`;

    return {
        /** Loopback origin, without the capability path. */
        origin,
        /** Capability-scoped base path. Treat as a secret. */
        basePath,
        /** Full URL handed to the host for iframe rendering. */
        url: `${origin}${basePath}/`,
        /** True once `close` has run. */
        get closed() {
            return closed;
        },
        /** Validate and select an artifact, then notify the live renderer. */
        async setTarget(artifactId) {
            if (closed) return 0;
            await buildArtifactPayload(workspaceRoot, artifactId);
            selectedArtifactId = artifactId;
            targetRevision += 1;
            return this.notifyRefresh();
        },
        /** Notify live renderer streams that on-disk content may have changed. */
        notifyRefresh() {
            if (closed) return 0;
            let notified = 0;
            for (const stream of liveStreams) {
                try {
                    stream.write("event: refresh\ndata: {}\n\n");
                    notified += 1;
                } catch {
                    liveStreams.delete(stream);
                }
            }
            return notified;
        },
        /** Invalidate the capability, end live responses, and release the port. */
        async close() {
            if (closed) return;
            closed = true;
            for (const stream of liveStreams) {
                try {
                    stream.end();
                } catch {
                    // The stream is already gone; nothing further is required.
                }
            }
            liveStreams.clear();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
