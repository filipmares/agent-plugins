import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createFixture, interactionProbe, parseOptions, startupProbe, summarize } from "./bench-notes-startup";
import { parseNote, ULID } from "../plugins/notes/extensions/notes/note-format.mjs";
import { NotesLibrary } from "../plugins/notes/extensions/notes/storage.mjs";

test("bulk fixtures survive the real parser and watched scan without adoption or warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "notes-bench-test-"));
    const library = new NotesLibrary(root);
    try {
        const fixture = await createFixture(root, 33);
        const before = new Map<string, string>();
        for (const path of await readdir(root, { recursive: true })) {
            if (!path.endsWith(".md")) continue;
            const raw = await readFile(join(root, path), "utf8");
            const parsed = parseNote(raw);
            expect(parsed.warning).toBeUndefined();
            expect(ULID.test(parsed.metadata.id)).toBe(true);
            before.set(path, raw);
        }
        expect(before.size).toBe(33);
        await library.startWatching(() => {});
        const listed = await library.list();
        expect(listed.warnings).toEqual([]);
        expect(listed.notes).toHaveLength(33);
        expect(new Set(listed.notes.map(note => note.id)).size).toBe(33);
        expect((await library.read(fixture.selected)).body).toContain("benchmarkneedle");
        expect((await library.read(fixture.opened)).body).toStartWith("# Benchmark note 1\n");
        expect((await library.list({ folder: "Work" })).notes.filter(note => note.folder === "Work")).toHaveLength(fixture.workCount);
        expect((await library.list({ query: "benchmarkneedle" })).notes.map(note => note.id)).toEqual([fixture.selected]);
        for (const [path, raw] of before) expect(await readFile(join(root, path), "utf8")).toBe(raw);
    } finally {
        library.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("invalid benchmark arguments fail rather than producing empty or misleading results", () => {
    for (const argv of [
        ["--notes", "0"], ["--notes", "1"], ["--notes", "2.5"], ["--samples", "NaN"],
        ["--samples", "0"], ["--cpu-throttle", "Infinity"], ["--cpu-throttle", "0"],
        ["--timeout-ms", "-1"], ["--timeout-ms", "2147483648"],
    ]) expect(() => parseOptions(argv)).toThrow();
    expect(parseOptions(["--notes", "10000", "--samples", "7"]).notes).toBe("10000");
});

test("summary uses nearest-rank p90 and refuses missing or non-finite samples", () => {
    expect(summarize(Array.from({ length: 10 }, (_, index) => ({ startup: index + 1 }))).startup)
        .toEqual({ count: 10, median: 5.5, p90: 9, min: 1, max: 10 });
    expect(summarize([{ startup: 1 }, { startup: 100 }]).startup.median).toBe(50.5);
    expect(summarize([{ startup: 1 }]).startup.p90).toBeNull();
    expect(() => summarize([{ startup: 1 }, {}])).toThrow("Incomplete metric");
    expect(() => summarize([{ startup: NaN }])).toThrow("Incomplete metric");
});

test("UI milestone waits for the changed DOM and its first paint opportunity", async () => {
    let notify = () => {};
    let paint = () => {};
    let disconnected = false;
    let time = 0;
    const state = { requested: false, rendered: false };
    const result = runInNewContext(interactionProbe("state.requested = true", "state.rendered", 1000), {
        state, document: {}, performance: { now: () => time }, setTimeout, clearTimeout,
        MutationObserver: class {
            constructor(callback: () => void) { notify = callback; }
            observe() {}
            disconnect() { disconnected = true; }
        },
        requestAnimationFrame: (callback: () => void) => { paint = callback; },
    }) as Promise<number>;
    let resolved = false;
    void result.then(() => { resolved = true; });
    expect(state.requested).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(resolved).toBe(false);
    expect(disconnected).toBe(false);
    state.rendered = true;
    notify();
    expect(disconnected).toBe(true);
    expect(resolved).toBe(false);
    time = 42;
    paint();
    expect(await result).toBe(42);
});

test("missing UI milestone fails explicitly after the requested timeout", async () => {
    let disconnected = false;
    const started = performance.now();
    const result = runInNewContext(interactionProbe("", "false", 40), {
        document: {}, performance, setTimeout, clearTimeout, requestAnimationFrame: () => {},
        MutationObserver: class {
            observe() {}
            disconnect() { disconnected = true; }
        },
    }) as Promise<number>;
    await expect(result).rejects.toThrow("UI interaction timed out");
    expect(performance.now() - started).toBeGreaterThanOrEqual(30);
    expect(disconnected).toBe(true);
});

test("startup reports the real UI load error instead of waiting for a paint that cannot happen", async () => {
    const result = runInNewContext(startupProbe(null), {
        performance, document: { querySelector: () => ({ textContent: "Notes is still loading the library. Try again in a moment." }) },
    }) as Promise<unknown>;
    await expect(result).rejects.toThrow("Startup failed: Notes is still loading the library");
});

test("a painted editor with the wrong restored note fails the identity check", async () => {
    const result = await runInNewContext(startupProbe("expected-id"), {
        performance: {
            now: () => 1,
            getEntriesByName: () => [{}],
            getEntriesByType: (type: string) => type === "navigation" ? [{ responseEnd: 1, domContentLoadedEventEnd: 1 }] : [],
        },
        document: {
            querySelectorAll: () => ({ length: 2 }),
            querySelector: (selector: string) => selector === ".rich-note"
                ? { hidden: false, querySelector: () => ({ textContent: "Benchmark note 0" }) }
                : selector.includes("aria-selected") ? { dataset: { key: "wrong-id" } } : null,
        },
    });
    expect(result.editorText).toBeGreaterThan(0);
    expect(result.restored).toBe(false);
});
