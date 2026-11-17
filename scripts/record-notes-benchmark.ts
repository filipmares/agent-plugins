import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

type Metric = { median: number; p90: number | null };
type Result = {
    notes: number;
    status: "complete" | "failed";
    exit: number;
    samples?: number;
    browserVersion?: string;
    runtime?: string;
    os?: string;
    cpu?: string;
    cpuThrottle?: number;
    scenario?: string;
    sample?: number;
    metrics: Record<string, Record<string, Metric>>;
};
type Run = {
    id: string;
    date: string;
    commit: string;
    url: string;
    runnerImage: string;
    benchmarkVersion: string;
    results: Result[];
};
const metrics = ["application-to-usable", "initial-scan", "open-note", "search", "warm-folder", "warm-all"];

export function compactResult(size: number, exit: number, source: string): Result {
    let data: any;
    try { data = JSON.parse(source); } catch { data = null; }
    const complete = exit === 0 && data?.status === "complete" && data.notes === size
        && Number.isSafeInteger(data.samples) && data.samples > 1;
    const result: Result = {
        notes: size,
        status: complete ? "complete" : "failed",
        exit,
        metrics: {},
    };
    if (!data || typeof data !== "object") return result;
    for (const key of ["samples", "browserVersion", "runtime", "os", "cpu", "cpuThrottle"] as const) {
        if (typeof data[key] === (key === "samples" || key === "cpuThrottle" ? "number" : "string")) {
            Object.assign(result, { [key]: data[key] });
        }
    }
    if (typeof data.failure?.scenario === "string") result.scenario = data.failure.scenario;
    if (Number.isSafeInteger(data.failure?.sample)) result.sample = data.failure.sample;
    if (complete) {
        for (const scenario of ["restored-note", "list-only"]) {
            const values: Record<string, Metric> = {};
            for (const name of metrics) {
                const metric = data.scenarios?.[scenario]?.[name];
                if (!Number.isFinite(metric?.median) || (metric.p90 !== null && !Number.isFinite(metric.p90))) {
                    result.status = "failed";
                    result.metrics = {};
                    return result;
                }
                values[name] = { median: metric.median, p90: metric.p90 };
            }
            result.metrics[scenario] = values;
        }
    }
    return result;
}

export function compatible(a: Run, ar: Result, b: Run, br: Result): boolean {
    return !!a.benchmarkVersion && a.benchmarkVersion === b.benchmarkVersion
        && a.runnerImage === b.runnerImage && ar.notes === br.notes && ar.status === "complete" && br.status === "complete"
        && !!ar.browserVersion && !!ar.runtime && !!ar.os && !!ar.cpu
        && ar.browserVersion === br.browserVersion && ar.runtime === br.runtime && ar.os === br.os && ar.cpu === br.cpu
        && ar.cpuThrottle === br.cpuThrottle && ar.samples === br.samples;
}

export function renderSummary(run: Run, previous: Run[]): string {
    const lines = [
        "## Notes daily benchmark",
        "",
        "Fresh application scans; OS disk caches and Copilot host launch are not measured. Hosted runner noise can obscure small changes.",
        "",
        "| Notes | Scenario | Status | Startup p50 / p90 | Previous 7 days p50 |",
        "| ---: | --- | --- | ---: | ---: |",
    ];
    for (const result of run.results) {
        if (result.status !== "complete") {
            lines.push(`| ${result.notes} | ${result.scenario ?? "setup"} | FAILED (exit ${result.exit}) | — | — |`);
            continue;
        }
        for (const scenario of ["restored-note", "list-only"]) {
            const metric = result.metrics[scenario]["application-to-usable"];
            const prior = previous.flatMap(item => {
                const age = Date.parse(run.date) - Date.parse(item.date);
                const other = item.results.find(candidate => compatible(run, result, item, candidate));
                return age > 0 && age <= 7 * 86400000 && other ? [other.metrics[scenario]["application-to-usable"].median] : [];
            }).sort((a, b) => a - b);
            const mid = Math.floor(prior.length / 2);
            const median = prior.length ? (prior.length % 2 ? prior[mid] : (prior[mid - 1] + prior[mid]) / 2) : null;
            lines.push(`| ${result.notes} | ${scenario} | complete | ${(metric.median / 1000).toFixed(2)} / ${metric.p90 === null ? "n/a" : (metric.p90 / 1000).toFixed(2)} s | ${median === null ? "no compatible runs" : `${(median / 1000).toFixed(2)} s (n=${prior.length})`} |`);
        }
    }
    lines.push("", "Comparison requires the same benchmark code, fixture size, sample count, CPU throttle, runner image, CPU, OS, Bun and browser version. Download raw JSON and logs from this run's artifacts.");
    return lines.join("\n") + "\n";
}

async function main() {
    const [historyDir, resultsDir, siteDir] = process.argv.slice(2);
    if (!historyDir || !resultsDir || !siteDir) throw new Error("Usage: record-notes-benchmark <history-dir> <results-dir> <site-dir>");
    const exits = JSON.parse(await readFile(join(resultsDir, "exits.json"), "utf8")) as Record<string, number>;
    const results: Result[] = [];
    for (const size of [1000, 10000]) {
        if (!Number.isInteger(exits[size])) throw new Error(`Missing exit status for ${size} notes.`);
        const source = await readFile(join(resultsDir, `${size}.json`), "utf8");
        results.push(compactResult(size, exits[size], source));
    }
    const { GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_STEP_SUMMARY, ImageOS, ImageVersion } = process.env;
    if (![GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_STEP_SUMMARY, ImageOS, ImageVersion].every(Boolean)) {
        throw new Error("Missing GitHub run or runner metadata.");
    }
    const run: Run = {
        id: `${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}`, date: new Date().toISOString(), commit: GITHUB_SHA!,
        url: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
        runnerImage: `${ImageOS} ${ImageVersion}`,
        benchmarkVersion: execFileSync("git", ["rev-parse", "HEAD:scripts/bench-notes-startup.ts"], { encoding: "utf8" }).trim(),
        results,
    };
    const historyPath = join(historyDir, "history.json");
    let history: Run[];
    try { history = JSON.parse(await readFile(historyPath, "utf8")); }
    catch (error: any) {
        if (error.code !== "ENOENT") throw error;
        history = [];
    }
    if (!Array.isArray(history)) throw new Error("Benchmark history must be an array.");
    const previous = history.filter(item => item.id !== run.id);
    const next = [...previous, run];
    await mkdir(siteDir, { recursive: true });
    const json = JSON.stringify(next, null, 2) + "\n";
    await writeFile(historyPath, json);
    await writeFile(join(siteDir, "history.json"), json);
    await writeFile(join(resultsDir, "status.json"), JSON.stringify(results.map(({ notes, status }) => ({ notes, status }))));
    for (const file of ["index.html", "dashboard.js"]) {
        await copyFile(join("scripts", "notes-benchmark-dashboard", file), join(historyDir, file));
        await copyFile(join("scripts", "notes-benchmark-dashboard", file), join(siteDir, file));
    }
    await writeFile(GITHUB_STEP_SUMMARY!, renderSummary(run, previous), { flag: "a" });
}

if (import.meta.main) await main();
