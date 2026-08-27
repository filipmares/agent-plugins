/**
 * Semantic tests for the loopback server, renderer, and canvas provider.
 *
 * Owns escaped rendering, HTTP methods and routes, the per-instance capability
 * trust model, refresh behavior, open idempotency, action success and error
 * variants, and resource cleanup.
 *
 * The Copilot SDK is only resolvable inside the CLI's extension fork, so it is
 * replaced with a minimal stand-in that mirrors the parts the provider uses.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class StubCanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

const stubLog = [];
let stubWorkspacePath;

mock.module("@github/copilot-sdk/extension", () => ({
    CanvasError: StubCanvasError,
    createCanvas: (options) => options,
    joinSession: async () => ({
        get workspacePath() {
            return stubWorkspacePath;
        },
        log: async (message, options) => {
            stubLog.push({ message, options });
        },
    }),
}));

const { ERROR_CODES, LIMITS } = await import("../artifact-index.mjs");
const { createNavigatorServer, buildArtifactList } = await import("../server.mjs");
const { escapeHtml, renderNavigatorHtml, NAVIGATOR_SCRIPT, NAVIGATOR_STYLES } = await import("../renderer.mjs");
const provider = await import("../extension.mjs");

let workspace;
const openServers = [];

function write(relativePath, contents) {
    const absolute = join(workspace, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
    return absolute;
}

async function startServer() {
    const server = await createNavigatorServer({ workspaceRoot: workspace, title: "RPI Artifact Navigator" });
    openServers.push(server);
    return server;
}

/** Fetch through the capability path with the exact loopback Host header. */
function call(server, path, options = {}) {
    const { headers = {}, ...rest } = options;
    return fetch(`${server.origin}${path}`, {
        headers: { Host: server.origin.replace("http://", ""), ...headers },
        redirect: "manual",
        ...rest,
    });
}

beforeEach(async () => {
    workspace = await realpath(mkdtempSync(join(tmpdir(), "rpi-canvas-server-")));
    stubWorkspacePath = workspace;
    stubLog.length = 0;
});

afterEach(async () => {
    while (openServers.length > 0) await openServers.pop().close();
    for (const instanceId of ["instance-a", "instance-b", "instance-c"]) {
        await provider.closeNavigator({ instanceId });
    }
    rmSync(workspace, { recursive: true, force: true });
});

describe("renderer output", () => {
    test("escapes HTML metacharacters in every context", () => {
        expect(escapeHtml('<script>"x"&\'y\'</script>')).toBe(
            "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
        );
    });

    test("escapes a hostile provider-supplied title", () => {
        const html = renderNavigatorHtml({ title: '</title><script>alert(1)</script>' });
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    test("contains no inline script or style and no remote assets", () => {
        const html = renderNavigatorHtml({});
        expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
        expect(html).not.toContain("<style");
        expect(html).not.toContain("http://");
        expect(html).not.toContain("https://");
        expect(html).not.toContain("contenteditable");
    });

    test("uses semantic landmarks, a live status region, and a keyboard skip link", () => {
        const html = renderNavigatorHtml({});
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain("<nav aria-labelledby=");
        expect(html).toContain('class="skip-link"');
        expect(html).toContain('tabindex="0"');
        expect(html).toContain('lang="en"');
    });

    test("styles declare focus visibility, reduced motion, and both themes", () => {
        expect(NAVIGATOR_STYLES).toContain(":focus-visible");
        expect(NAVIGATOR_STYLES).toContain("prefers-reduced-motion: reduce");
        expect(NAVIGATOR_STYLES).toContain("prefers-color-scheme: dark");
        expect(NAVIGATOR_STYLES).toContain("color-scheme: light dark");
        expect(NAVIGATOR_STYLES).toContain("max-width: 60rem");
    });

    test("the client script assigns artifact text through textContent only", () => {
        expect(NAVIGATOR_SCRIPT).toContain("sourceEl.textContent = doc.source");
        expect(NAVIGATOR_SCRIPT).not.toContain("innerHTML");
        expect(NAVIGATOR_SCRIPT).not.toContain("outerHTML");
        expect(NAVIGATOR_SCRIPT).not.toContain("document.write");
        expect(NAVIGATOR_SCRIPT).not.toContain("eval(");
    });
});

describe("server routing and trust model", () => {
    test("binds to loopback on an ephemeral port with a 256-bit capability", async () => {
        const server = await startServer();
        expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(server.basePath).toMatch(/^\/[0-9a-f]{64}$/);
        expect(server.url).toBe(`${server.origin}${server.basePath}/`);
    });

    test("issues a distinct capability per instance", async () => {
        const first = await startServer();
        const second = await startServer();
        expect(first.basePath).not.toBe(second.basePath);
    });

    test("serves the document, stylesheet, and script under the capability path", async () => {
        const server = await startServer();

        const document = await call(server, `${server.basePath}/`);
        expect(document.status).toBe(200);
        expect(document.headers.get("content-type")).toContain("text/html");

        const styles = await call(server, `${server.basePath}/app.css`);
        expect(styles.status).toBe(200);
        expect(styles.headers.get("content-type")).toContain("text/css");

        const script = await call(server, `${server.basePath}/app.js`);
        expect(script.status).toBe(200);
        expect(script.headers.get("content-type")).toContain("text/javascript");
    });

    test("sets restrictive security headers on every response", async () => {
        const server = await startServer();
        for (const path of [`${server.basePath}/`, `${server.basePath}/api/artifacts`, "/missing"]) {
            const response = await call(server, path);
            const csp = response.headers.get("content-security-policy");
            expect(csp).toContain("default-src 'none'");
            expect(csp).toContain("script-src 'self'");
            expect(csp).toContain("connect-src 'self'");
            expect(csp).not.toContain("unsafe-inline");
            expect(csp).not.toContain("frame-ancestors");
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(response.headers.get("referrer-policy")).toBe("no-referrer");
            expect(response.headers.get("x-content-type-options")).toBe("nosniff");
            expect(response.headers.get("access-control-allow-origin")).toBeNull();
        }
    });

    test("rejects a missing or wrong capability without disclosure", async () => {
        const server = await startServer();
        write(".copilot-tracking/plans/2026-08-27/secret-plan.md", "# Confidential heading");

        const wrongToken = `/${"a".repeat(64)}`;
        for (const path of ["/", "/api/artifacts", `${wrongToken}/api/artifacts`, `${server.basePath}x/api/artifacts`]) {
            const response = await call(server, path);
            expect(response.status).toBe(404);
            const body = await response.text();
            expect(body).not.toContain("Confidential");
            expect(body).not.toContain(server.basePath.slice(1));
            expect(body).not.toContain(workspace);
        }
    });

    test("rejects a hostile Host header", async () => {
        const server = await startServer();
        for (const host of ["evil.example", "127.0.0.1:1", "localhost:80"]) {
            const response = await call(server, `${server.basePath}/api/artifacts`, { headers: { Host: host } });
            expect(response.status).toBe(404);
        }
    });

    test("accepts the exact loopback Origin and rejects every other origin", async () => {
        const server = await startServer();

        const sameOrigin = await call(server, `${server.basePath}/api/artifacts`, {
            headers: { Origin: server.origin },
        });
        expect(sameOrigin.status).toBe(200);

        for (const origin of ["http://evil.example", "null", "http://127.0.0.1:1"]) {
            const response = await call(server, `${server.basePath}/api/artifacts`, { headers: { Origin: origin } });
            expect(response.status).toBe(404);
            expect(response.headers.get("access-control-allow-origin")).toBeNull();
        }
    });

    test("allows an absent Origin for the initial iframe navigation", async () => {
        const server = await startServer();
        const response = await call(server, `${server.basePath}/`);
        expect(response.status).toBe(200);
    });

    test("refuses preflight without granting CORS", async () => {
        const server = await startServer();
        const response = await call(server, `${server.basePath}/api/artifacts`, {
            method: "OPTIONS",
            headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "GET" },
        });
        expect(response.status).toBe(405);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("access-control-allow-methods")).toBeNull();
    });

    test("rejects disallowed methods and routes", async () => {
        const server = await startServer();

        for (const method of ["PUT", "DELETE", "PATCH"]) {
            const response = await call(server, `${server.basePath}/api/artifacts`, { method });
            expect(response.status).toBe(404);
        }
        expect((await call(server, `${server.basePath}/api/artifacts`, { method: "POST" })).status).toBe(404);
        expect((await call(server, `${server.basePath}/api/refresh`)).status).toBe(404);
        expect((await call(server, `${server.basePath}/../etc/passwd`)).status).toBe(404);
        expect((await call(server, `${server.basePath}/api/unknown`)).status).toBe(404);
    });

    test("returns an explicit error for a disallowed artifactId and a missing parameter", async () => {
        const server = await startServer();

        const missing = await call(server, `${server.basePath}/api/artifact`);
        expect(missing.status).toBe(400);
        expect((await missing.json()).error).toBe(ERROR_CODES.requestInvalid);

        const outside = await call(server, `${server.basePath}/api/artifact?artifactId=README.md`);
        expect(outside.status).toBe(403);
        expect((await outside.json()).error).toBe(ERROR_CODES.artifactNotAllowed);

        const traversal = await call(
            server,
            `${server.basePath}/api/artifact?artifactId=${encodeURIComponent(".copilot-tracking/plans/../../x.md")}`,
        );
        expect((await traversal.json()).error).toBe(ERROR_CODES.artifactIdInvalid);
    });

    test("serves artifact source as JSON that is never interpolated into markup", async () => {
        const hostile = '# Title\n\n<script>alert("xss")</script>\n';
        write(".copilot-tracking/plans/2026-08-27/hostile-plan.md", hostile);
        const server = await startServer();

        const response = await call(
            server,
            `${server.basePath}/api/artifact?artifactId=${encodeURIComponent(".copilot-tracking/plans/2026-08-27/hostile-plan.md")}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");

        const body = await response.json();
        expect(body.artifact.source).toBe(hostile);

        const html = await (await call(server, `${server.basePath}/`)).text();
        expect(html).not.toContain("alert(\"xss\")");
    });
});

describe("refresh and cleanup", () => {
    test("the refresh POST re-reads from disk without writing", async () => {
        const server = await startServer();
        expect((await (await call(server, `${server.basePath}/api/artifacts`)).json()).count).toBe(0);

        write(".copilot-tracking/plans/2026-08-27/new-plan.md", "# New");
        const refreshed = await call(server, `${server.basePath}/api/refresh`, { method: "POST" });
        expect(refreshed.status).toBe(200);
        const body = await refreshed.json();
        expect(body.count).toBe(1);
        expect(body.artifacts[0].id).toBe(".copilot-tracking/plans/2026-08-27/new-plan.md");
    });

    test("notifyRefresh reports the streams it reached and is inert with none", async () => {
        const server = await startServer();
        expect(server.notifyRefresh()).toBe(0);
    });

    test("close invalidates the capability and refuses later requests", async () => {
        const server = await startServer();
        const path = `${server.basePath}/api/artifacts`;
        expect((await call(server, path)).status).toBe(200);

        await server.close();
        expect(server.closed).toBe(true);
        expect(server.notifyRefresh()).toBe(0);

        let failed = false;
        try {
            await call(server, path);
        } catch {
            failed = true;
        }
        expect(failed).toBe(true);
    });

    test("close is idempotent", async () => {
        const server = await startServer();
        await server.close();
        await server.close();
        expect(server.closed).toBe(true);
    });
});

describe("artifact listing", () => {
    test("returns deterministic ascending order and an exact count", async () => {
        write(".copilot-tracking/research/2026-08-27/z-research.md", "# Z");
        write(".copilot-tracking/plans/2026-08-27/a-plan.md", "# A\n\n* Planning status: Ready\n");
        write(".copilot-tracking/changes/2026-08-27/m-changes.md", "# M");

        const payload = await buildArtifactList(workspace);
        expect(payload.count).toBe(3);
        expect(payload.artifacts.map((a) => a.id)).toEqual([
            ".copilot-tracking/changes/2026-08-27/m-changes.md",
            ".copilot-tracking/plans/2026-08-27/a-plan.md",
            ".copilot-tracking/research/2026-08-27/z-research.md",
        ]);
        expect(payload.artifacts[1]).toMatchObject({ type: "plan", status: "Ready", taskSlug: "a" });
    });

    test("skips an artifact that exceeds the file limit rather than failing the list", async () => {
        write(".copilot-tracking/plans/2026-08-27/ok-plan.md", "# Ok");
        write(".copilot-tracking/plans/2026-08-27/huge-plan.md", "a".repeat(LIMITS.maxFileBytes + 1));

        const payload = await buildArtifactList(workspace);
        expect(payload.artifacts.map((a) => a.id)).toEqual([".copilot-tracking/plans/2026-08-27/ok-plan.md"]);
    });
});

describe("canvas provider contract", () => {
    test("declares one canvas with the exact id, schema, and three actions", () => {
        const declaration = provider.canvasDeclaration;
        expect(declaration.id).toBe("rpi-artifact-navigator");
        expect(declaration.displayName).toBe("RPI Artifact Navigator");
        expect(typeof declaration.description).toBe("string");
        expect(declaration.inputSchema).toEqual({ type: "object", additionalProperties: false });
        expect(declaration.actions.map((action) => action.name)).toEqual([
            "list_rpi_artifacts",
            "get_rpi_artifact",
            "refresh_rpi_artifacts",
        ]);
        for (const action of declaration.actions) {
            expect(action.name.startsWith("canvas.")).toBe(false);
            expect(typeof action.handler).toBe("function");
            expect(action.inputSchema.additionalProperties).toBe(false);
        }
        expect(declaration.actions[1].inputSchema.required).toEqual(["artifactId"]);
    });

    test("list_rpi_artifacts returns a raw object, not a string or envelope", async () => {
        write(".copilot-tracking/plans/2026-08-27/a-plan.md", "# A");
        const result = await provider.listRpiArtifacts({ input: {} });

        expect(typeof result).toBe("object");
        expect(Array.isArray(result.artifacts)).toBe(true);
        expect(result.count).toBe(1);
        expect(Object.keys(result).sort()).toEqual(["artifacts", "count"]);
        expect(result).not.toHaveProperty("success");
        expect(result).not.toHaveProperty("content");
    });

    test("get_rpi_artifact returns the document read model", async () => {
        const source = "# Example\n\n## Section\n";
        write(".copilot-tracking/plans/2026-08-27/example-plan.md", source);

        const result = await provider.getRpiArtifact({
            input: { artifactId: ".copilot-tracking/plans/2026-08-27/example-plan.md" },
        });
        expect(Object.keys(result)).toEqual(["artifact"]);
        expect(result.artifact.source).toBe(source);
        expect(result.artifact.headings).toEqual([
            { ordinal: 1, level: 1, text: "Example" },
            { ordinal: 2, level: 2, text: "Section" },
        ]);
        expect(result.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test("refresh_rpi_artifacts counts live instances and never writes", async () => {
        write(".copilot-tracking/plans/2026-08-27/a-plan.md", "# A");

        const idle = await provider.refreshRpiArtifacts({ input: {} });
        expect(idle.refreshedInstances).toBe(0);
        expect(Object.keys(idle).sort()).toEqual(["artifacts", "count", "refreshedInstances"]);

        await provider.openNavigator({ instanceId: "instance-a", session: { workingDirectory: workspace } });
        await provider.openNavigator({ instanceId: "instance-b", session: { workingDirectory: workspace } });

        const live = await provider.refreshRpiArtifacts({ input: {} });
        expect(live.refreshedInstances).toBe(2);
        expect(live.count).toBe(1);
    });

    test.each([
        ["list_rpi_artifacts", (input) => provider.listRpiArtifacts({ input }), { unexpected: true }, ERROR_CODES.requestInvalid],
        ["refresh_rpi_artifacts", (input) => provider.refreshRpiArtifacts({ input }), [1], ERROR_CODES.requestInvalid],
        ["get_rpi_artifact missing", (input) => provider.getRpiArtifact({ input }), {}, ERROR_CODES.requestInvalid],
        ["get_rpi_artifact extra", (input) => provider.getRpiArtifact({ input }), { artifactId: "a.md", extra: 1 }, ERROR_CODES.requestInvalid],
        ["get_rpi_artifact empty", (input) => provider.getRpiArtifact({ input }), { artifactId: "" }, ERROR_CODES.artifactIdInvalid],
        ["get_rpi_artifact traversal", (input) => provider.getRpiArtifact({ input }), { artifactId: "../../etc/passwd.md" }, ERROR_CODES.artifactIdInvalid],
        ["get_rpi_artifact outside", (input) => provider.getRpiArtifact({ input }), { artifactId: "README.md" }, ERROR_CODES.artifactNotAllowed],
        ["get_rpi_artifact absent", (input) => provider.getRpiArtifact({ input }), { artifactId: ".copilot-tracking/plans/2026-08-27/absent-plan.md" }, ERROR_CODES.artifactNotFound],
    ])("%s rejects invalid input with a closed error code", async (_label, invoke, input, code) => {
        let thrown;
        try {
            await invoke(input);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(StubCanvasError);
        expect(thrown.code).toBe(code);
        expect(Object.values(ERROR_CODES)).toContain(thrown.code);
    });

    test("actions fail closed when no workspace is available", async () => {
        stubWorkspacePath = undefined;
        let thrown;
        try {
            await provider.listRpiArtifacts({ input: {} });
        } catch (err) {
            thrown = err;
        }
        expect(thrown.code).toBe(ERROR_CODES.workspaceUnavailable);
    });

    test("open is idempotent for one instance and distinct across instances", async () => {
        const first = await provider.openNavigator({ instanceId: "instance-a", session: { workingDirectory: workspace } });
        const again = await provider.openNavigator({ instanceId: "instance-a", session: { workingDirectory: workspace } });
        const other = await provider.openNavigator({ instanceId: "instance-b", session: { workingDirectory: workspace } });

        expect(again.url).toBe(first.url);
        expect(other.url).not.toBe(first.url);
        expect(first.title).toBe("RPI Artifact Navigator");
    });

    test("a fresh instance resolves the same artifact content because files own identity", async () => {
        const source = "# Shared\n";
        const artifactId = ".copilot-tracking/plans/2026-08-27/shared-plan.md";
        write(artifactId, source);

        await provider.openNavigator({ instanceId: "instance-a", session: { workingDirectory: workspace } });
        const fromA = await provider.getRpiArtifact({ input: { artifactId }, instanceId: "instance-a" });
        await provider.closeNavigator({ instanceId: "instance-a" });

        await provider.openNavigator({ instanceId: "instance-c", session: { workingDirectory: workspace } });
        const fromC = await provider.getRpiArtifact({ input: { artifactId }, instanceId: "instance-c" });

        expect(fromC.artifact.sha256).toBe(fromA.artifact.sha256);
        expect(fromC.artifact.source).toBe(source);
    });

    test("open fails closed when the host reports no canvas support", async () => {
        let thrown;
        try {
            await provider.openNavigator({
                instanceId: "instance-a",
                host: { capabilities: { canvases: false } },
                session: { workingDirectory: workspace },
            });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(StubCanvasError);
        expect(thrown.code).toBe(ERROR_CODES.canvasUnsupported);
        expect(thrown.message).toContain("directly");
    });

    test("open fails closed when no workspace is available", async () => {
        stubWorkspacePath = undefined;
        let thrown;
        try {
            await provider.openNavigator({ instanceId: "instance-a" });
        } catch (err) {
            thrown = err;
        }
        expect(thrown.code).toBe(ERROR_CODES.workspaceUnavailable);
    });

    test("close releases exactly the named instance", async () => {
        const a = await provider.openNavigator({ instanceId: "instance-a", session: { workingDirectory: workspace } });
        const b = await provider.openNavigator({ instanceId: "instance-b", session: { workingDirectory: workspace } });

        await provider.closeNavigator({ instanceId: "instance-a" });

        const bStillServes = await fetch(`${b.url}api/artifacts`, { headers: { Host: new URL(b.url).host } });
        expect(bStillServes.status).toBe(200);

        let aFailed = false;
        try {
            await fetch(`${a.url}api/artifacts`, { headers: { Host: new URL(a.url).host } });
        } catch {
            aFailed = true;
        }
        expect(aFailed).toBe(true);

        // Re-opening the closed instance provisions a new capability.
        const reopened = await provider.openNavigator({ instanceId: "instance-a", session: { workingDirectory: workspace } });
        expect(reopened.url).not.toBe(a.url);
    });

    test("closing an unknown instance is a no-op", async () => {
        await provider.closeNavigator({ instanceId: "never-opened" });
    });

    test("provider logging never carries a capability token or absolute path", async () => {
        await provider.openNavigator({ instanceId: "instance-a", session: { workingDirectory: workspace } });
        for (const entry of stubLog) {
            expect(entry.message).not.toMatch(/[0-9a-f]{64}/);
            expect(entry.message).not.toContain(workspace);
        }
    });
});
