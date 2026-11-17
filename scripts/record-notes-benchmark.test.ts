import { expect, test } from "bun:test";
import { compactResult, compatible, renderSummary } from "./record-notes-benchmark";

const metric = { median: 1000, p90: 2000 };
const values = Object.fromEntries(["application-to-usable", "initial-scan", "open-note", "search", "warm-folder", "warm-all"].map(name => [name, metric]));
const data = {
    status: "complete", notes: 1000, samples: 7, browserVersion: "Edge 1", runtime: "Bun 1",
    os: "Windows", cpu: "CPU", cpuThrottle: 1,
    scenarios: { "restored-note": values, "list-only": values },
};
const result = compactResult(1000, 0, JSON.stringify(data));
const run = { id: "1:1", date: "2026-01-08T00:00:00Z", commit: "abc", url: "https://example.com", runnerImage: "image", benchmarkVersion: "fixture-v1", results: [result] };

test("compact history keeps usable measurements, never logs or raw samples", () => {
    const compact = compactResult(1000, 0, JSON.stringify({ ...data, rawSamples: ["secret"], failure: { message: "private token" } }));
    expect(compact.status).toBe("complete");
    expect(compact.metrics["list-only"].search).toEqual(metric);
    expect(JSON.stringify(compact)).not.toContain("secret");
    expect(JSON.stringify(compact)).not.toContain("private token");
});

test("failures and invalid output remain failures with no fabricated metrics", () => {
    for (const [exit, source] of [
        [1, JSON.stringify({ ...data, status: "failed", failure: { scenario: "restored-note", sample: 1 } })],
        [0, "not json"], [0, JSON.stringify({ ...data, scenarios: {} })],
        [0, JSON.stringify({ ...data, notes: 10000 })],
    ] as const) {
        const failed = compactResult(1000, exit, source);
        expect(failed.status).toBe("failed");
        expect(failed.metrics).toEqual({});
    }
});

test("comparisons use only matching environments and completed runs in the previous seven days", () => {
    const previous = { ...run, id: "2:1", date: "2026-01-07T00:00:00Z" };
    const old = { ...run, id: "3:1", date: "2025-12-01T00:00:00Z" };
    const changed = { ...previous, id: "4:1", runnerImage: "different" };
    expect(compatible(run, result, previous, result)).toBe(true);
    expect(compatible(run, result, changed, result)).toBe(false);
    expect(compatible(run, result, { ...previous, benchmarkVersion: "fixture-v2" }, result)).toBe(false);
    expect(compatible(run, result, previous, { ...result, status: "failed" })).toBe(false);
    const summary = renderSummary(run, [previous, old, changed]);
    expect(summary).toContain("1.00 s (n=1)");
    expect(summary).toContain("1.00 / 2.00 s");
    expect(renderSummary({ ...run, results: [{ ...result, status: "failed", exit: 1, metrics: {} }] }, [])).toContain("FAILED (exit 1)");
});
