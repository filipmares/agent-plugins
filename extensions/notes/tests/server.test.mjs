import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_REQUEST_BYTES, createNotesServer, resolveTarget } from "../server.mjs";
import { NotesLibrary } from "../storage.mjs";
import { popRecovery, pushRecovery, recoveryPath } from "../ui-state.mjs";

let fixture, library, server, statePath, changes;

async function start(target) {
    server = await createNotesServer({
        getLibrary: async () => library,
        getContext: async () => ({ sessionId: "session-a", sessionName: "Panel session", project: "owner/repo" }),
        sessionId: "session-a",
        statePath,
        target,
        onChange: () => { changes += 1; },
    });
    return server;
}

beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "copilot-notes-server-"));
    library = new NotesLibrary(join(fixture, "notes"), { trash: async path => {
        await mkdir(join(fixture, "trash"), { recursive: true });
        await rename(path, join(fixture, "trash", basename(path)));
    } });
    statePath = join(fixture, "state", "ui-state.json");
    changes = 0;
});

afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(fixture, { recursive: true, force: true });
});

function call(path, { method = "GET", headers = {}, body, base = server.url } = {}) {
    const url = new URL(path, base);
    const origin = url.origin;
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const sent = {
        Host: url.host,
        ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}),
        ...headers,
    };
    for (const key of Object.keys(sent)) if (sent[key] === null) delete sent[key];
    return new Promise((resolve, reject) => {
        const req = request(url, { method, headers: sent }, res => {
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

function events(path = "api/events") {
    const url = new URL(path, server.url);
    const received = [];
    const waiters = [];
    let buffer = "";
    let res;
    const ready = new Promise((resolve, reject) => {
        const req = request(url, { headers: { Host: url.host } }, response => {
            res = response;
            response.setEncoding("utf8");
            response.on("data", chunk => {
                buffer += chunk;
                if (buffer.includes(": connected")) resolve();
                let end;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const block = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const event = /^event: (.+)$/m.exec(block)?.[1];
                    const data = /^data: (.+)$/m.exec(block)?.[1];
                    if (event) received.push({ event, data: JSON.parse(data) });
                }
                for (const waiter of waiters.splice(0)) waiter();
            });
        });
        req.on("error", reject);
        req.end();
    });
    return {
        ready,
        async next() {
            while (!received.length) await new Promise(resolve => waiters.push(resolve));
            return received.shift();
        },
        close: () => res?.destroy(),
    };
}

describe("Notes panel server", () => {
    test("serves the shell with a strict CSP behind a capability token, exact Host and same-origin POSTs", async () => {
        await start();
        const shell = await call("");
        expect(shell.status).toBe(200);
        expect(shell.text).toContain('<script src="app.js" defer></script>');
        expect(shell.headers["content-security-policy"]).toContain("default-src 'none'");
        expect(shell.headers["content-security-policy"]).toContain("script-src 'self'");
        expect(shell.headers).toMatchObject({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
        expect(shell.headers["access-control-allow-origin"]).toBeUndefined();
        expect((await call("app.js")).headers["content-type"]).toStartWith("text/javascript");
        expect((await call("app.css")).headers["content-type"]).toStartWith("text/css");

        const origin = new URL(server.url).origin;
        expect((await call("/not-the-token/", { base: origin })).status).toBe(404);
        expect((await call("api/folders", { headers: { Host: "localhost" } })).status).toBe(404);
        expect((await call("api/folders", { headers: { Origin: "http://evil.example" } })).status).toBe(404);
        const note = { body: "# Hello", folder: "" };
        expect((await call("api/note/create", { method: "POST", body: note, headers: { Origin: null } })).status).toBe(404);
        expect((await call("api/note/create", { method: "POST", body: note, headers: { Origin: "null" } })).status).toBe(404);
        expect((await call("api/note/create", { method: "POST", body: note, headers: { "Content-Type": "text/plain" } })).status).toBe(415);
        expect((await call("api/note/create", { method: "POST", body: { ...note, extra: 1 } })).json.error.code).toBe("invalid_request");
        const tooLarge = await call("api/note/create", { method: "POST", body: "{}", headers: { "Content-Length": String(MAX_REQUEST_BYTES + 1) } })
            .catch(error => ({ error }));
        if (!tooLarge.error) expect(tooLarge.status).toBe(413);
        expect(changes).toBe(0);
        expect(await library.list()).toMatchObject({ notes: [] });
    });

    test("creates, updates and filters notes, reporting stale writes as conflicts", async () => {
        await start();
        const created = await call("api/note/create", { method: "POST", body: { body: "# Groceries\nMilk", folder: "Home" } });
        expect(created.status).toBe(200);
        expect(created.json.frontmatter).toMatchObject({ created_by: "user", session_id: "session-a", project: "owner/repo" });
        await library.create({ body: "# Elsewhere", folder: "" }, { sessionId: "session-b", actor: "agent" });

        const updated = await call("api/note/update", { method: "POST", body: { id: created.json.id, body: "# Groceries\nMilk\nEggs", expectedVersion: created.json.version } });
        expect(updated.json.body).toContain("Eggs");
        const stale = await call("api/note/update", { method: "POST", body: { id: created.json.id, body: "# Groceries\nOld", expectedVersion: created.json.version } });
        expect(stale.status).toBe(409);
        expect(stale.json.error.code).toBe("conflict");
        expect(changes).toBe(2);

        const titles = async query => (await call(`api/notes?${query}`)).json.notes.map(note => note.title).sort();
        expect(await titles("view=all")).toEqual(["Elsewhere", "Groceries"]);
        expect(await titles("view=session")).toEqual(["Groceries"]);
        expect(await titles("view=project")).toEqual(["Groceries"]);
        expect(await titles("folder=home")).toEqual(["Groceries"]);
        expect(await titles("folder=")).toEqual(["Elsewhere"]);
        expect(await titles("query=eggs")).toEqual(["Groceries"]);
        expect((await call("api/notes")).status).toBe(400);
        expect((await call(`api/note?id=${encodeURIComponent(created.json.id)}`)).json.title).toBe("Groceries");
        expect((await call("api/note?id=missing.md")).status).toBe(404);
    });

    test("persists valid UI state and rejects malformed state", async () => {
        await start();
        expect((await call("api/state")).json.ui).toEqual({ sidebar: true, selection: { view: "all" }, noteId: null, collapsed: [] });
        const state = { sidebar: false, selection: { folder: "Home" }, noteId: "abc", collapsed: ["Home"] };
        expect((await call("api/ui", { method: "POST", body: { state } })).json).toEqual(state);
        expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(state);
        const bad = await call("api/ui", { method: "POST", body: { state: { ...state, selection: { view: "bogus" } } } });
        expect(bad.status).toBe(400);
        expect((await call("api/state")).json.ui).toEqual(state);
    });

    test("hands the open target to the first state load and streams reveal and change events", async () => {
        await start({ folder: "Home" });
        expect((await call("api/state")).json).toMatchObject({ context: { sessionId: "session-a", project: "owner/repo" }, target: { folder: "Home" } });
        expect((await call("api/state")).json.target).toBeNull();

        const stream = events();
        await stream.ready;
        server.reveal({ view: "session" });
        expect(await stream.next()).toEqual({ event: "reveal", data: { view: "session" } });
        server.notifyChange();
        expect(await stream.next()).toEqual({ event: "changed", data: {} });
        stream.close();

        // A reveal sent while no stream is connected reaches the next stream to connect.
        await new Promise(resolve => setTimeout(resolve, 20));
        server.reveal({ view: "all" });
        const late = events();
        expect(await late.next()).toEqual({ event: "reveal", data: { view: "all" } });
        late.close();

        await server.close();
        expect(server.closed).toBe(true);
    });

    test("rescues a closing panel's text, keeping it for recovery when the note changed elsewhere", async () => {
        await start();
        const rescue = body => call("api/note/rescue", { method: "POST", body });

        const draft = await rescue({ draft: "d1", folder: "Home", body: "# Draft\nunsaved" });
        expect(draft.json).toMatchObject({ title: "Draft", folder: "Home" });
        const late = await call("api/note/create", { method: "POST", body: { body: "# Draft\nolder", folder: "Home", draft: "d1" } });
        expect(late.json).toMatchObject({ id: draft.json.id, body: draft.json.body });

        // A save from this panel landed after the text it rescues was loaded, so the newer version is still its own.
        const created = await call("api/note/create", { method: "POST", body: { body: "# Plan\none", folder: "", draft: "d2" } });
        const saved = await call("api/note/update", { method: "POST", body: { id: created.json.id, body: "# Plan\ntwo", expectedVersion: created.json.version } });
        expect((await rescue({ draft: "d2", folder: "", body: "# Plan\nthree" })).json.body).toContain("three");
        expect((await rescue({ id: created.json.id, folder: "", body: "# Plan\nfour", expectedVersion: saved.json.version })).json.body).toContain("four");

        await library.update(created.json.id, { body: "# Plan\nagent", expectedVersion: (await library.read(created.json.id)).version }, { sessionId: "s", actor: "agent" });
        expect((await rescue({ id: created.json.id, folder: "", body: "# Plan\nmine", expectedVersion: saved.json.version })).json).toEqual({ recovered: true });
        expect((await library.read(created.json.id)).body).toContain("agent");
        expect((await call("api/state")).json.recovery).toEqual({ noteId: created.json.id, folder: "", body: "# Plan\nmine" });
        expect((await call("api/state")).json.recovery).toBeNull();

        // Stash-only rescue never writes over this panel's own newer save.
        const own = await library.read(created.json.id);
        await call("api/note/update", { method: "POST", body: { id: own.id, body: "# Plan\nnewest", expectedVersion: own.version } });
        expect((await rescue({ id: own.id, folder: "", body: "# Plan\nolder", stash: true })).json).toEqual({ recovered: true });
        expect((await library.read(own.id)).body).toContain("newest");
        expect((await call("api/state")).json.recovery.body).toBe("# Plan\nolder");

        const dir = recoveryPath(statePath);
        await Promise.all(["a", "b", "c"].map(body => pushRecovery(dir, { folder: "", body })));
        const popped = await Promise.all([1, 2, 3, 4].map(() => popRecovery(dir)));
        expect(popped.filter(Boolean).map(entry => entry.body).sort()).toEqual(["a", "b", "c"]);
    });

    test("keeps unresolved recovery across closes without overwriting the fresh version", async () => {
        await start();
        const created = await call("api/note/create", { method: "POST", body: { body: "# Shared\nCurrent external text", folder: "" } });
        const current = created.json;
        const recovery = { noteId: current.id, folder: "", body: "# Shared\nOlder recovered draft" };
        await pushRecovery(recoveryPath(statePath), recovery);

        for (let reopen = 0; reopen < 2; reopen++) {
            expect((await call("api/state")).json.recovery).toEqual(recovery);
            const fresh = (await call(`api/note?id=${current.id}`)).json;
            const rescued = await call("api/note/rescue", { method: "POST", body: {
                id: fresh.id, folder: fresh.folder, body: recovery.body, expectedVersion: fresh.version, stash: true,
            } });
            expect(rescued.status).toBe(200);
            expect(rescued.json).toEqual({ recovered: true });
            expect(await library.read(current.id)).toMatchObject({ body: current.body, version: current.version });
            await server.close();
            await start();
        }

        expect((await call("api/state")).json.recovery).toEqual(recovery);
        const kept = await call("api/note/update", { method: "POST", body: {
            id: current.id, body: recovery.body, expectedVersion: current.version,
        } });
        expect(kept.status).toBe(200);
        expect((await library.read(current.id)).body).toBe(recovery.body);
        expect((await call("api/state")).json.recovery).toBeNull();
    });

    test("resolves canvas targets to canonical identifiers", async () => {
        const note = await library.create({ body: "# Target", folder: "Work/Plans" }, { sessionId: "s", actor: "user" });
        expect(await resolveTarget(library, { noteId: note.path })).toEqual({ noteId: note.id, folder: "Work/Plans" });
        expect(await resolveTarget(library, { folder: "work\\plans" })).toEqual({ folder: "Work/Plans" });
        expect(await resolveTarget(library, { view: "all", noteId: note.id })).toEqual({ view: "all", noteId: note.id });
        await expect(resolveTarget(library, { folder: "Nope" })).rejects.toMatchObject({ code: "not_found" });
        await expect(resolveTarget(library, { noteId: "missing.md" })).rejects.toMatchObject({ code: "not_found" });
    });
});
