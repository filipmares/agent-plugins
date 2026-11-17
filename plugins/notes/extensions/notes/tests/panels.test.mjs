import { describe, expect, test } from "bun:test";
import { createPanelRegistry } from "../panels.mjs";

function fakeServers() {
    const servers = [];
    const gates = [];
    const start = () => {
        const server = { url: `http://panel/${servers.length}`, closed: false, async close() { this.closed = true; } };
        servers.push(server);
        return new Promise(resolve => gates.push(() => resolve(server)));
    };
    return { servers, gates, start };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("panel registry", () => {
    test("a close during server startup cancels that opening without starting another server", async () => {
        const panels = createPanelRegistry();
        const { servers, gates, start } = fakeServers();
        const opening = panels.open("a", async () => ({}), start);
        await tick();
        const closing = panels.close("a");
        gates[0]();
        await expect(opening).rejects.toMatchObject({ code: "panel_closed" });
        await closing;
        expect(servers).toHaveLength(1);
        expect(servers[0].closed).toBe(true);
        expect(await panels.find("a")).toBeUndefined();
    });

    test("a close while the target resolves cancels the opening, and a later reopen still works", async () => {
        const panels = createPanelRegistry();
        const { servers, gates, start } = fakeServers();
        let resolveTarget;
        const opening = panels.open("a", () => new Promise(resolve => { resolveTarget = resolve; }), start);
        await panels.close("a");
        resolveTarget({});
        await expect(opening).rejects.toMatchObject({ code: "panel_closed" });
        expect(servers).toHaveLength(0);

        const reopening = panels.open("a", async () => ({}), start);
        await tick();
        gates[0]();
        expect((await reopening).url).toBe("http://panel/0");
        expect(await panels.find("a")).toBe(servers[0]);
    });

    test("concurrent opens share one server", async () => {
        const panels = createPanelRegistry();
        const { servers, gates, start } = fakeServers();
        const first = panels.open("a", async () => ({}), start);
        const second = panels.open("a", async () => ({}), start);
        await tick();
        gates[0]();
        expect(await first).toBe(await second);
        expect(servers).toHaveLength(1);
    });
});
