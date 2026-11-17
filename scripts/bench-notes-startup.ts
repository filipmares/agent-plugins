// Measures a fresh Notes library scan and usable UI in headless Edge/Chrome.
// OS disk caches are NOT flushed. This is not a full Copilot host launch.
//
//   bun run bench:notes [--notes 1000] [--samples 7] [--cpu-throttle 4] [--browser <path>] [--json]
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createNotesServer } from "../extensions/notes/server.mjs";
import { NotesLibrary } from "../extensions/notes/storage.mjs";
import { ShadowIndex } from "../extensions/notes/shadow-index.mjs";
import { saveUiState } from "../extensions/notes/ui-state.mjs";
import { newId, parseNote } from "../extensions/notes/note-format.mjs";

export function parseOptions(argv: string[]) {
    const { values } = parseArgs({
        args: argv,
        options: {
            notes: { type: "string", default: "1000" },
            samples: { type: "string", default: "7" },
            "cpu-throttle": { type: "string", default: "1" },
            browser: { type: "string" },
            json: { type: "boolean", default: false },
            "timeout-ms": { type: "string", default: "120000" },
        },
    });
    for (const key of ["notes", "samples", "timeout-ms"] as const) {
        if (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < (key === "notes" ? 2 : 1)) {
            throw new Error(`--${key} must be an integer >= ${key === "notes" ? 2 : 1}.`);
        }
    }
    if (!Number.isFinite(Number(values["cpu-throttle"])) || Number(values["cpu-throttle"]) < 1) {
        throw new Error("--cpu-throttle must be a finite number >= 1.");
    }
    if (Number(values["timeout-ms"]) > 2_147_481_647) throw new Error("--timeout-ms exceeds the supported timer range.");
    return values;
}
const args = parseOptions(import.meta.main ? process.argv.slice(2) : []);
const NOTE_COUNT = Number(args.notes);
const SAMPLES = Number(args.samples);
const THROTTLE = Number(args["cpu-throttle"]);
const TIMEOUT = Number(args["timeout-ms"]);
const vendor = new URL("../extensions/notes/vendor/", import.meta.url);

function findBrowser() {
    const candidates = [
        args.browser, process.env.NOTES_BENCH_BROWSER,
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ];
    const found = candidates.find(path => path && existsSync(path));
    if (!found) throw new Error("No Chromium browser found. Pass --browser or set NOTES_BENCH_BROWSER.");
    return found;
}

// ---------- Fixture ----------

const WORDS = ("decision release rollout migration latency budget owner review design schema cache index token " +
    "session project branch deploy rollback incident metric dashboard alert query service client server").split(" ");
let seed = 42;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
const sentence = (words: number) => {
    const text = Array.from({ length: words }, () => pick(WORDS)).join(" ");
    return text[0].toUpperCase() + text.slice(1) + ".";
};

function noteBody(index: number, sections: number) {
    const lines = [`# Benchmark note ${index}`, "", index === 0 ? "benchmarkneedle" : sentence(18)];
    for (let section = 0; section < sections; section++) {
        lines.push("", `## ${sentence(3).slice(0, -1)}`, "", `${sentence(12)} See [the runbook](https://example.com/${index}/${section}).`, "");
        for (let item = 0; item < 4; item++) lines.push(`- ${item % 2 ? "**" + pick(WORDS) + "** " : ""}${sentence(8)}`);
        if (section % 2) lines.push("", "```ts", `const ${pick(WORDS)} = await load("${pick(WORDS)}");`, "```");
        if (section % 3 === 2) lines.push("", "| Owner | Status |", "| --- | --- |", `| ${pick(WORDS)} | ${pick(WORDS)} |`);
    }
    return lines.join("\n") + "\n";
}

export async function createFixture(directory: string, count: number) {
    seed = 42;
    const folders = ["", "Work", "Work/Platform", "Work/Platform/Incidents", "Work/Design", "Personal", "Archive/2024", "Archive/2025"];
    await Promise.all(folders.map(folder => mkdir(join(directory, folder), { recursive: true })));
    const ids: string[] = [];
    let workCount = 0;
    // Bounded batches avoid create()'s per-write full scan without skipping real parsing.
    for (let offset = 0; offset < count; offset += 32) {
        const writes = [];
        for (let index = offset; index < Math.min(offset + 32, count); index++) {
            const id = newId(1_735_689_600_000 + index, Buffer.alloc(10));
            ids.push(id);
            const folder = folders[index % folders.length];
            if (folder === "Work") workCount++;
            const body = noteBody(index, index === 0 ? 24 : 1 + (index % 4));
            const raw = `---\nid: ${id}\ncreated: "2025-01-01T00:00:00.000+00:00"\nupdated: "2025-01-01T00:00:00.000+00:00"\nsessions: []\ncreated_by: user\n---\n${body}`;
            const path = join(directory, folder, `note-${index}.md`);
            writes.push((async () => {
                await writeFile(path, raw, { flag: "wx" });
                const parsed = parseNote(await readFile(path, "utf8"));
                if (parsed.warning || parsed.metadata.id !== id || parsed.body !== body) {
                    throw new Error(`Invalid fixture ${path}: ${parsed.warning?.message ?? "metadata/body mismatch"}`);
                }
            })());
        }
        await Promise.all(writes);
    }
    if (new Set(ids).size !== count) throw new Error("Duplicate fixture IDs.");
    return { selected: ids[0], opened: ids[1], workCount };
}

// ---------- CDP ----------

class Cdp {
    #socket: WebSocket;
    #id = 0;
    #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    #listeners = new Map<string, ((params: any) => void)[]>();

    private constructor(socket: WebSocket) {
        this.#socket = socket;
        socket.addEventListener("message", event => {
            const message = JSON.parse(String(event.data));
            if (message.id !== undefined) {
                const pending = this.#pending.get(message.id);
                this.#pending.delete(message.id);
                if (message.error) pending?.reject(new Error(message.error.message));
                else pending?.resolve(message.result);
            } else {
                for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
            }
        });
        socket.addEventListener("close", () => this.#failPending(new Error("CDP connection closed")));
        socket.addEventListener("error", () => this.#failPending(new Error("CDP connection failed")));
    }

    #failPending(error: Error) {
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
    }

    static async connect(url: string) {
        const socket = new WebSocket(url);
        try {
            return await withTimeout(new Promise<Cdp>((resolve, reject) => {
                socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
                socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
            }), "CDP connection");
        } catch (error) { socket.close(); throw error; }
    }

    send(method: string, params: Record<string, unknown> = {}) {
        const id = ++this.#id;
        this.#socket.send(JSON.stringify({ id, method, params }));
        return withTimeout(new Promise<any>((resolve, reject) => this.#pending.set(id, { resolve, reject })), method,
            method === "Runtime.evaluate" ? TIMEOUT + 2000 : TIMEOUT)
            .finally(() => this.#pending.delete(id));
    }

    on(method: string, listener: (params: any) => void) {
        this.#listeners.set(method, [...this.#listeners.get(method) ?? [], listener]);
    }

    once(method: string) {
        return new Promise<any>(resolve => this.on(method, resolve));
    }

    close() { this.#failPending(new Error("CDP connection closed")); this.#socket.close(); }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>, what: string, timeout = TIMEOUT): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), timeout);
        })]);
    } finally { clearTimeout(timer); }
}

async function launchBrowser(executable: string) {
    const profile = await mkdtemp(join(tmpdir(), "notes-bench-profile-"));
    const child = spawn(executable, [
        "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
        "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
        "--disable-background-networking", "--disable-component-update", "--window-size=1280,800", "about:blank",
    ], { stdio: "ignore" });
    let launchError: Error | undefined;
    child.once("error", error => { launchError = error; });
    const portFile = join(profile, "DevToolsActivePort");
    let launching = true;
    try {
        const port = await withTimeout((async () => {
            while (launching) {
                if (launchError) throw launchError;
                if (child.exitCode !== null) throw new Error(`Browser exited (${child.exitCode})`);
                try {
                    const [line] = (await readFile(portFile, "utf8")).split("\n");
                    if (line.trim()) return Number(line);
                } catch { /* not written yet */ }
                await delay(25);
            }
            return 0;
        })(), "the browser debugging port");
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(TIMEOUT) })).json() as { type: string; webSocketDebuggerUrl: string }[];
        const page = targets.find(target => target.type === "page");
        if (!page) throw new Error("The browser has no page target.");
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(TIMEOUT) })).json() as { webSocketDebuggerUrl: string; Browser: string };
        return { child, profile, page: await Cdp.connect(page.webSocketDebuggerUrl), browserUrl: version.webSocketDebuggerUrl, version: version.Browser };
    } catch (error) {
        launching = false;
        await stopBrowser(child, profile);
        throw error;
    }
}

async function stopBrowser(child: ChildProcess, profile: string) {
    if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once("exit", resolve));
        child.kill();
        await Promise.race([exited, delay(5000)]);
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error("Browser did not exit.");
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function closeBrowser({ child, profile, page, browserUrl }: { child: ChildProcess; profile: string; page: Cdp; browserUrl: string }) {
    page.close();
    const exited = new Promise(resolve => child.once("exit", resolve));
    try {
        const browser = await Cdp.connect(browserUrl);
        void browser.send("Browser.close").catch(() => {});
        await Promise.race([exited, delay(5000)]);
        browser.close();
    } catch { /* fall through to kill */ }
    await stopBrowser(child, profile);
}

// ---------- Measurement ----------

type Sample = Record<string, number>;

// Runs in the page: waits for the scenario's last milestone, then checks real content rendered.
export const startupProbe = (noteId: string | null) => `new Promise((resolve, reject) => {
    const want = ${JSON.stringify(noteId ? "notes:editor-painted" : "notes:list-painted")};
    const deadline = performance.now() + ${TIMEOUT};
    const check = () => {
        const failure = document.querySelector(".rows .list-error");
        if (failure) { reject(new Error("Startup failed: " + failure.textContent)); return; }
        if (!performance.getEntriesByName(want).length) {
            if (performance.now() > deadline) reject(new Error("missing " + want));
            else setTimeout(check, 10);
            return;
        }
        const rows = document.querySelectorAll(".rows .row").length;
        const rich = document.querySelector(".rich-note");
        const editorText = rich && !rich.hidden ? (rich.querySelector(".ProseMirror[contenteditable=true]")?.textContent ?? "").length : 0;
        const restored = ${noteId === null ? "true" : `document.querySelector('.row[aria-selected=true]')?.dataset.key === ${JSON.stringify(noteId)}
            && rich?.querySelector(".ProseMirror h1")?.textContent === "Benchmark note 0"`};
        const nav = performance.getEntriesByType("navigation")[0];
        const requests = {};
        for (const entry of performance.getEntriesByType("resource")) {
            const route = new URL(entry.name).pathname.replace(/^\\/[^/]+\\//, "");
            if (!(route.startsWith("api/") || route.endsWith(".js")) || route === "api/events" || route in requests) continue;
            requests[route] = [entry.startTime, entry.responseEnd];
        }
        const marks = {};
        for (const entry of performance.getEntriesByType("mark")) {
            if (entry.name.startsWith("notes:") && !(entry.name.slice(6) in marks)) marks[entry.name.slice(6)] = entry.startTime;
        }
        resolve({ rows, editorText, restored, requests, marks, html: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd });
    };
    check();
})`;

// A condition must describe the new rendered state, not just a completed HTTP request.
export function interactionProbe(action: string, ready: string, timeout = TIMEOUT) {
    return `new Promise((resolve, reject) => {
        const start = performance.now();
        const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error("UI interaction timed out: " + ${JSON.stringify(ready)}));
        }, ${timeout});
        let painting = false;
        const check = () => {
            if (!painting && (${ready})) {
                painting = true;
                observer.disconnect();
                requestAnimationFrame(() => setTimeout(() => {
                    clearTimeout(timer);
                    resolve(performance.now() - start);
                }));
            }
        };
        const observer = new MutationObserver(check);
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        try { ${action}; check(); }
        catch (error) { clearTimeout(timer); observer.disconnect(); reject(error); }
    })`;
}

async function evaluate(page: Cdp, expression: string) {
    const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) {
        const snapshot = await page.send("Runtime.evaluate", {
            expression: `JSON.stringify({ title: document.querySelector(".list-title")?.textContent,
                rows: document.querySelectorAll(".rows .row").length,
                listState: document.querySelector(".rows")?.textContent.slice(0, 400),
                alert: document.querySelector(".toast:not([hidden])")?.textContent,
                rich: document.querySelector(".rich-note")?.outerHTML.slice(0, 800),
                selected: document.querySelector('.row[aria-selected=true]')?.dataset.key })`,
            returnByValue: true,
        });
        throw new Error(`${exceptionDetails.exception?.description ?? exceptionDetails.text}\nUI: ${snapshot.result.value}`);
    }
    return result.value;
}

async function interactions(page: Cdp, fixture: Awaited<ReturnType<typeof createFixture>>) {
    const out: Sample = {};
    const rows = `document.querySelectorAll(".rows .row")`;
    const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).click()`;
    out["open-note"] = await evaluate(page, interactionProbe(
        click(`.row[data-key="${fixture.opened}"]`),
        `document.querySelector('.row[aria-selected=true]')?.dataset.key === ${JSON.stringify(fixture.opened)}
            && document.querySelector('.rich-note:not([hidden]) .ProseMirror[contenteditable=true] h1')?.textContent === "Benchmark note 1"`,
    ));
    out.search = await evaluate(page, interactionProbe(
        `const input = document.querySelector('input[type=search]'); input.value = "benchmarkneedle"; input.dispatchEvent(new Event("input", { bubbles: true }))`,
        `${rows}.length === 1 && ${rows}[0].dataset.key === ${JSON.stringify(fixture.selected)}
            && document.querySelector(".list-title")?.textContent === "Search"`,
    ));
    out["warm-folder"] = await evaluate(page, interactionProbe(
        click('[data-focus-key="folder:Work"]'),
        `${rows}.length === ${fixture.workCount} && document.querySelector(".list-title")?.textContent === "Work"
            && [...${rows}].every(row => row.querySelector(".row-folder") === null)`,
    ));
    out["warm-all"] = await evaluate(page, interactionProbe(
        click('[data-focus-key="smart:all"]'),
        `${rows}.length === ${NOTE_COUNT} && document.querySelector(".list-title")?.textContent === "All Notes"`,
    ));
    return out;
}

async function sample(executable: string, notesDirectory: string, statePath: string, fixture: Awaited<ReturnType<typeof createFixture>>, noteId: string | null) {
    await saveUiState(statePath, { sidebar: true, selection: { view: "all" }, noteId, collapsed: [] });
    let server: Awaited<ReturnType<typeof createNotesServer>> | undefined;
    const errors: string[] = [];
    // Like production, the shadow index persists across launches: the first sample builds it.
    const index = new ShadowIndex({ directory: join(notesDirectory, "..", "index"), onFailure: (error: Error) => errors.push(`Shadow index: ${error.message}`) });
    const library = new NotesLibrary(notesDirectory, { index });
    let ready: Promise<NotesLibrary> | undefined;
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    try {
        browser = await launchBrowser(executable);
        const { page } = browser;
        page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
        page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (type === "error") errors.push(args.map((arg: any) => arg.value ?? arg.description).join(" ")); });
        page.on("Log.entryAdded", ({ entry }) => { if (entry.level === "error" && !entry.url?.endsWith("/favicon.ico")) errors.push(`${entry.text} ${entry.url ?? ""}`); });
        await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Log.enable")]);
        await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        if (THROTTLE > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
        // Browser launch/profile setup is excluded; the application scan is not.
        const started = performance.now();
        let scanMs = 0;
        ready = library.startWatching(() => {}, { onFailure: (error: Error) => errors.push(`Watcher: ${error.message}`) }).then(() => {
            scanMs = performance.now() - started;
            return library;
        });
        // Attach a rejection handler immediately, even before the first API call.
        void ready.catch((error: Error) => errors.push(`Initial scan: ${error.message}`));
        server = await createNotesServer({ getLibrary: () => ready!, getContext: async () => ({}), sessionId: undefined, statePath });
        const loaded = page.once("Page.loadEventFired");
        await page.send("Page.navigate", { url: server.url });
        await withTimeout(loaded, "the page load");
        const value = await evaluate(page, startupProbe(noteId));
        const usableMs = performance.now() - started;
        if (value.rows !== NOTE_COUNT) throw new Error(`Expected ${NOTE_COUNT} rows; rendered ${value.rows}.`);
        if (noteId !== null && (value.editorText < 1 || !value.restored)) throw new Error("The expected restored note did not render in the rich editor.");
        await withTimeout(ready, "the initial library scan");
        const actions = await interactions(page, fixture);
        if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);
        const out: Sample = { "application-to-usable": usableMs, "initial-scan": scanMs, ...actions, html: value.html, domContentLoaded: value.domContentLoaded };
        for (const [name, time] of Object.entries(value.marks as Record<string, number>)) out[name] = time;
        for (const [route, [begin, end]] of Object.entries(value.requests as Record<string, [number, number]>)) {
            out[`${route} start`] = begin;
            out[`${route} end`] = end;
        }
        return { metrics: out, browserVersion: browser.version };
    } catch (error) {
        throw new Error(`Benchmark failed${browser ? ` (${browser.version})` : ""}.${errors.length ? `\nBrowser errors:\n${errors.join("\n")}` : ""}`, { cause: error });
    } finally {
        try {
            if (browser) await closeBrowser(browser);
        } finally {
            await server?.close();
            // A timed-out scan cannot be cancelled; the CLI failure exits the process.
            try {
                if (ready) await withTimeout(ready, "scan cleanup");
            } finally { library.close(); }
        }
    }
}

const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

export function summarize(samples: Sample[]) {
    const names = [...new Set(samples.flatMap(Object.keys))];
    return Object.fromEntries(names.map(name => {
        const values = samples.map(item => item[name]).filter(value => typeof value === "number");
        if (values.length !== samples.length || values.some(value => !Number.isFinite(value))) throw new Error(`Incomplete metric: ${name}`);
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        return [name, { count: values.length, median, p90: values.length > 1 ? percentile(values, 0.9) : null, min: Math.min(...values), max: Math.max(...values) }];
    }));
}

async function main() {
    const executable = findBrowser();
    const fixture = await mkdtemp(join(tmpdir(), "notes-bench-"));
    try {
        const notesDirectory = join(fixture, "notes");
        const statePath = join(fixture, "state", "ui.json");
        const started = performance.now();
        const generated = await withTimeout(createFixture(notesDirectory, NOTE_COUNT), "fixture generation and parser validation");
        const fixtureMs = performance.now() - started;
        console.error(`Generated and parsed ${NOTE_COUNT} valid notes in ${Math.round(fixtureMs)} ms.`);
        const sizes = Object.fromEntries(await Promise.all(["notes-client.js", "notes-editor.js"].map(async file =>
            [file, (await stat(new URL(file, vendor))).size] as const)));
        const results = {
            status: "complete",
            browser: executable, browserVersion: "", runtime: `Bun ${Bun.version}`, os: `${platform()} ${release()} ${process.arch}`,
            cpu: cpus()[0]?.model, notes: NOTE_COUNT, samples: SAMPLES, cpuThrottle: THROTTLE, timeoutMs: TIMEOUT,
            fixtureMs, bundleBytes: sizes,
            limitations: "Fresh NotesLibrary/watch/scan, server and browser profile per sample; same Bun process and OS disk cache. The SQLite shadow index persists across samples, so only the first sample builds it. Excludes browser launch, module loading and Copilot host/SDK startup. CPU throttle affects the renderer only. UI actions use DOM click/input handlers. application-to-usable is host-observed; initial-scan shares its origin. Other startup marks/resources are navigation-relative; actions are handler-to-paint including search debounce. Warm views reuse the scanned library and page. p90 uses nearest rank; small sample counts have low confidence.",
            scenarios: {} as Record<string, ReturnType<typeof summarize>>,
            rawSamples: {} as Record<string, Sample[]>,
            failure: undefined as { scenario: string; sample: number; message: string } | undefined,
        };
        console.error(`${results.runtime}, ${results.os}; ${executable}; renderer CPU ${THROTTLE}x.`);
        for (const [name, noteId] of [["restored-note", generated.selected], ["list-only", null]] as const) {
            const samples: Sample[] = [];
            for (let run = 0; run < SAMPLES; run++) {
                try {
                    const result = await sample(executable, notesDirectory, statePath, generated, noteId);
                    samples.push(result.metrics);
                    results.browserVersion = result.browserVersion;
                } catch (error) {
                    results.status = "failed";
                    results.failure = { scenario: name, sample: run + 1, message: String(error) };
                    results.rawSamples[name] = samples;
                    if (args.json) console.log(JSON.stringify(results, null, 2));
                    throw new Error(`${name} sample ${run + 1}/${SAMPLES} failed`, { cause: error });
                }
                console.error(`${name} ${run + 1}/${SAMPLES}: application-to-usable ${samples[run]["application-to-usable"].toFixed(0)} ms, initial-scan ${samples[run]["initial-scan"].toFixed(0)} ms.`);
            }
            results.scenarios[name] = summarize(samples);
            results.rawSamples[name] = samples;
        }
        if (args.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
        }
        console.error("");
        console.log(`Notes startup: ${NOTE_COUNT} notes, ${SAMPLES} samples, CPU throttle ${THROTTLE}x, ${executable}`);
        console.log(`Bundles: ${Object.entries(sizes).map(([file, size]) => `${file} ${(size / 1024).toFixed(0)} KB`).join(", ")}`);
        console.log(`${results.runtime}, ${results.os}, ${results.browserVersion}`);
        console.log(results.limitations);
        console.log("Milliseconds (median / p90; n/a for one sample):");
        for (const [scenario, summary] of Object.entries(results.scenarios)) {
            console.log(`  ${scenario}`);
            const names = Object.keys(summary).sort((a, b) => summary[a].median - summary[b].median);
            for (const name of names) {
                const metric = summary[name];
                console.log(`    ${name.padEnd(24)} ${metric.median.toFixed(0).padStart(6)} / ${(metric.p90?.toFixed(0) ?? "n/a").padStart(6)}`);
            }
        }
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    try { await main(); }
    catch (error) {
        console.error(error);
        // Stop outstanding scans/CDP timers after cleanup instead of hanging on failure.
        process.exit(1);
    }
}
