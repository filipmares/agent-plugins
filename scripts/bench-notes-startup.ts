// Measures Notes panel startup in headless Edge/Chrome against a generated library.
// Each sample opens a fresh panel server in a fresh browser profile, like a newly opened canvas.
//
//   bun run bench:notes [--notes 1000] [--samples 7] [--cpu-throttle 4] [--browser <path>] [--json]
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createNotesServer } from "../extensions/notes/server.mjs";
import { NotesLibrary } from "../extensions/notes/storage.mjs";
import { saveUiState } from "../extensions/notes/ui-state.mjs";

const { values: args } = parseArgs({
    options: {
        notes: { type: "string", default: "1000" },
        samples: { type: "string", default: "7" },
        "cpu-throttle": { type: "string", default: "1" },
        browser: { type: "string" },
        json: { type: "boolean", default: false },
    },
});
const NOTE_COUNT = Number(args.notes);
const SAMPLES = Number(args.samples);
const THROTTLE = Number(args["cpu-throttle"]);
const TIMEOUT = 30_000;
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
    const lines = [`# ${sentence(4).slice(0, -1)} ${index}`, "", sentence(18)];
    for (let section = 0; section < sections; section++) {
        lines.push("", `## ${sentence(3).slice(0, -1)}`, "", `${sentence(12)} See [the runbook](https://example.com/${index}/${section}).`, "");
        for (let item = 0; item < 4; item++) lines.push(`- ${item % 2 ? "**" + pick(WORDS) + "** " : ""}${sentence(8)}`);
        if (section % 2) lines.push("", "```ts", `const ${pick(WORDS)} = await load("${pick(WORDS)}");`, "```");
        if (section % 3 === 2) lines.push("", "| Owner | Status |", "| --- | --- |", `| ${pick(WORDS)} | ${pick(WORDS)} |`);
    }
    return lines.join("\n") + "\n";
}

async function createFixture(directory: string) {
    const library = new NotesLibrary(directory, { trash: async () => { throw new Error("No trash in benchmarks"); } });
    const folders = ["", "Work", "Work/Platform", "Work/Platform/Incidents", "Work/Design", "Personal", "Archive/2024", "Archive/2025"];
    const context = { actor: "user" };
    let selected = "";
    for (let index = 0; index < NOTE_COUNT; index++) {
        // One larger note is what the restored-note scenario reopens.
        const note = await library.create({ body: noteBody(index, index === 0 ? 24 : 1 + (index % 4)), folder: folders[index % folders.length] }, context);
        if (index === 0) selected = note.id;
    }
    library.close();
    return selected;
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
    }

    static connect(url: string) {
        return new Promise<Cdp>((resolve, reject) => {
            const socket = new WebSocket(url);
            socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
            socket.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
        });
    }

    send(method: string, params: Record<string, unknown> = {}) {
        const id = ++this.#id;
        this.#socket.send(JSON.stringify({ id, method, params }));
        return new Promise<any>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    }

    on(method: string, listener: (params: any) => void) {
        this.#listeners.set(method, [...this.#listeners.get(method) ?? [], listener]);
    }

    once(method: string) {
        return new Promise<any>(resolve => this.on(method, resolve));
    }

    close() { this.#socket.close(); }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), TIMEOUT);
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
    const portFile = join(profile, "DevToolsActivePort");
    const port = await withTimeout((async () => {
        for (;;) {
            if (child.exitCode !== null) throw new Error(`Browser exited (${child.exitCode})`);
            try {
                const [line] = (await readFile(portFile, "utf8")).split("\n");
                if (line.trim()) return Number(line);
            } catch { /* not written yet */ }
            await delay(25);
        }
    })(), "the browser debugging port");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find(target => target.type === "page");
    if (!page) throw new Error("The browser has no page target.");
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    return { child, profile, page: await Cdp.connect(page.webSocketDebuggerUrl), browserUrl: version.webSocketDebuggerUrl };
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
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, delay(5000)]);
    for (let attempt = 0; attempt < 10; attempt++) {
        try { return await rm(profile, { recursive: true, force: true }); } catch { await delay(200); }
    }
}

// ---------- Measurement ----------

type Sample = Record<string, number>;

// Runs in the page: waits for the scenario's last milestone, then checks real content rendered.
const probe = (needsEditor: boolean) => `new Promise((resolve, reject) => {
    const want = ${JSON.stringify(needsEditor ? "notes:editor-painted" : "notes:list-painted")};
    const deadline = performance.now() + ${TIMEOUT - 2000};
    const check = () => {
        if (!performance.getEntriesByName(want).length) {
            if (performance.now() > deadline) reject(new Error("missing " + want));
            else setTimeout(check, 10);
            return;
        }
        const rows = document.querySelectorAll(".rows .row").length;
        const rich = document.querySelector(".rich-note");
        const editorText = rich && !rich.hidden ? (rich.querySelector(".ProseMirror")?.textContent ?? "").length : 0;
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
        resolve({ rows, editorText, requests, marks, html: nav.responseEnd, domContentLoaded: nav.domContentLoadedEventEnd });
    };
    check();
})`;

async function sample(executable: string, library: NotesLibrary, statePath: string, noteId: string | null) {
    await saveUiState(statePath, { sidebar: true, selection: { view: "all" }, noteId, collapsed: [] });
    const server = await createNotesServer({ getLibrary: async () => library, getContext: async () => ({}), sessionId: undefined, statePath });
    const browser = await launchBrowser(executable);
    const errors: string[] = [];
    try {
        const { page } = browser;
        page.on("Runtime.exceptionThrown", ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
        page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (type === "error") errors.push(args.map((arg: any) => arg.value ?? arg.description).join(" ")); });
        page.on("Log.entryAdded", ({ entry }) => { if (entry.level === "error" && !entry.url?.endsWith("/favicon.ico")) errors.push(`${entry.text} ${entry.url ?? ""}`); });
        await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Log.enable")]);
        await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
        if (THROTTLE > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
        const loaded = page.once("Page.loadEventFired");
        await page.send("Page.navigate", { url: server.url });
        await withTimeout(loaded, "the page load");
        const { result, exceptionDetails } = await withTimeout(page.send("Runtime.evaluate", {
            expression: probe(noteId !== null), awaitPromise: true, returnByValue: true,
        }), "startup milestones");
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        const value = result.value;
        if (value.rows < 1) throw new Error("The note list rendered no rows.");
        if (noteId !== null && value.editorText < 1) throw new Error("The restored note did not render in the rich editor.");
        if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);
        const out: Sample = { html: value.html, domContentLoaded: value.domContentLoaded };
        for (const [name, time] of Object.entries(value.marks as Record<string, number>)) out[name] = time;
        for (const [route, [begin, end]] of Object.entries(value.requests as Record<string, [number, number]>)) {
            out[`${route} start`] = begin;
            out[`${route} end`] = end;
        }
        return out;
    } finally {
        await closeBrowser(browser);
        await server.close();
    }
}

const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
};

function summarize(samples: Sample[]) {
    const names = [...new Set(samples.flatMap(Object.keys))];
    return Object.fromEntries(names.map(name => {
        const values = samples.map(item => item[name]).filter(value => typeof value === "number");
        return [name, { median: percentile(values, 0.5), p90: percentile(values, 0.9), min: Math.min(...values), max: Math.max(...values) }];
    }));
}

async function main() {
    const executable = findBrowser();
    const fixture = await mkdtemp(join(tmpdir(), "notes-bench-"));
    try {
        const notesDirectory = join(fixture, "notes");
        const statePath = join(fixture, "state", "ui.json");
        const started = performance.now();
        const selected = await createFixture(notesDirectory);
        if (!args.json) console.error(`Generated ${NOTE_COUNT} notes in ${Math.round(performance.now() - started)} ms.`);
        // Like the extension: one watched library per process, scanned before any panel opens.
        const library = new NotesLibrary(notesDirectory);
        await library.startWatching(() => {});
        const sizes = Object.fromEntries(await Promise.all(["notes-client.js", "notes-editor.js"].map(async file => {
            try { return [file, (await stat(new URL(file, vendor))).size]; } catch { return [file, null]; }
        })));
        const results: Record<string, unknown> = { browser: executable, notes: NOTE_COUNT, samples: SAMPLES, cpuThrottle: THROTTLE, bundleBytes: sizes, scenarios: {} };
        try {
            // One discarded warm-up run so OS file caches and browser binaries are hot for every scenario.
            await sample(executable, library, statePath, selected);
            for (const [name, noteId] of [["restored-note", selected], ["list-only", null]] as const) {
                const samples: Sample[] = [];
                for (let run = 0; run < SAMPLES; run++) {
                    samples.push(await sample(executable, library, statePath, noteId));
                    if (!args.json) process.stderr.write(".");
                }
                (results.scenarios as Record<string, unknown>)[name] = summarize(samples);
            }
        } finally {
            library.close();
        }
        if (args.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
        }
        console.error("");
        console.log(`Notes startup: ${NOTE_COUNT} notes, ${SAMPLES} samples, CPU throttle ${THROTTLE}x, ${executable}`);
        console.log(`Bundles: ${Object.entries(sizes).map(([file, size]) => `${file} ${size === null ? "-" : `${(size / 1024).toFixed(0)} KB`}`).join(", ")}`);
        console.log("Milliseconds from navigation start (median / p90):");
        for (const [scenario, summary] of Object.entries(results.scenarios as Record<string, Record<string, { median: number; p90: number }>>)) {
            console.log(`  ${scenario}`);
            const names = Object.keys(summary).sort((a, b) => summary[a].median - summary[b].median);
            for (const name of names) {
                const metric = summary[name];
                console.log(`    ${name.padEnd(22)} ${metric.median.toFixed(0).padStart(6)} / ${metric.p90.toFixed(0).padStart(6)}`);
            }
        }
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
}

await main();
