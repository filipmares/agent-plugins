const $ = id => document.getElementById(id);
const fields = ["size", "scenario", "metric", "stat"];
const svg = $("chart");
const ns = "http://www.w3.org/2000/svg";
const element = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
};
const sameEnvironment = (a, ar, b, br) => !!a.benchmarkVersion && a.benchmarkVersion === b.benchmarkVersion && a.runnerImage === b.runnerImage
    && ["notes", "samples", "browserVersion", "runtime", "os", "cpu", "cpuThrottle"].every(key => ar[key] === br[key])
    && !!ar.browserVersion && !!ar.runtime && !!ar.os && !!ar.cpu;

function renderChart(history) {
    const size = Number($("size").value);
    const scenario = $("scenario").value;
    const metric = $("metric").value;
    const stat = $("stat").value;
    const rows = history.map(run => ({ run, result: run.results.find(result => result.notes === size) })).filter(row => row.result);
    const latest = [...rows].reverse().find(row => row.result.status === "complete");
    svg.replaceChildren();
    if (!latest) {
        $("chart-info").textContent = "No successful runs for this library size. Failures are listed below.";
        return;
    }
    const matching = rows.filter(row => row.result.status === "complete" && sameEnvironment(latest.run, latest.result, row.run, row.result));
    const values = matching.map(row => ({ ...row, value: row.result.metrics?.[scenario]?.[metric]?.[stat] })).filter(row => Number.isFinite(row.value));
    $("chart-info").textContent = `${values.length} compatible successful runs; environment: ${latest.run.runnerImage}, ${latest.result.browserVersion}, ${latest.result.runtime}, ${latest.result.cpu}. Incompatible runs and failures are excluded from the line but remain in the table.`;
    if (!values.length) return;
    const max = Math.max(...values.map(row => row.value), 1) * 1.1;
    const minTime = Date.parse(values[0].run.date);
    const maxTime = Date.parse(values[values.length - 1].run.date);
    const x = time => maxTime === minTime ? 450 : 60 + (time - minTime) / (maxTime - minTime) * 810;
    const y = value => 260 - value / max * 230;
    svg.append(element("line", { x1: 60, x2: 870, y1: 260, y2: 260, stroke: "#8c959f" }));
    for (let i = 0; i <= 4; i++) {
        const value = max * i / 4;
        svg.append(element("text", { x: 52, y: y(value) + 4, "text-anchor": "end", class: "chart-label" }, (value / 1000).toFixed(1)));
    }
    // Break the line across failures or incompatible runs rather than implying a successful measurement.
    let points = [];
    const flush = () => {
        if (points.length > 1) svg.append(element("polyline", { points: points.join(" "), class: "series" }));
        points = [];
    };
    for (const row of rows) {
        const found = values.find(value => value.run.id === row.run.id);
        if (!found) { flush(); continue; }
        const cx = x(Date.parse(found.run.date)), cy = y(found.value);
        points.push(`${cx},${cy}`);
        const dot = element("circle", { cx, cy, r: 4, class: "point" });
        dot.append(element("title", {}, `${found.run.date}: ${(found.value / 1000).toFixed(2)} s`));
        svg.append(dot);
    }
    flush();
    svg.append(element("text", { x: 60, y: 287, class: "chart-label" }, values[0].run.date.slice(0, 10)));
    svg.append(element("text", { x: 870, y: 287, "text-anchor": "end", class: "chart-label" }, values[values.length - 1].run.date.slice(0, 10)));
}

function renderTable(history) {
    const table = $("runs");
    table.replaceChildren();
    for (const run of [...history].reverse()) {
        const row = document.createElement("tr");
        const cell = (text, className = "") => {
            const td = document.createElement("td");
            td.textContent = text;
            td.className = className;
            row.append(td);
        };
        const td = document.createElement("td");
        const link = document.createElement("a");
        link.href = run.url;
        link.textContent = run.date.replace("T", " ").slice(0, 19);
        td.append(link);
        row.append(td);
        cell(run.commit.slice(0, 7));
        for (const size of [1000, 10000]) {
            const result = run.results.find(item => item.notes === size);
            const status = result?.status ?? "missing";
            cell(status === "failed" ? `FAILED (${result.scenario ?? "setup"}, exit ${result.exit})` : status, status === "failed" ? "failed" : "");
        }
        const environment = run.results.find(result => result.status === "complete") ?? run.results[0];
        cell(`${run.runnerImage}; ${environment?.browserVersion || "browser unavailable"}; ${environment?.runtime || "runtime unavailable"}`);
        table.append(row);
    }
}

try {
    const response = await fetch("history.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const history = await response.json();
    if (!Array.isArray(history)) throw new Error("Invalid history");
    history.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    renderTable(history);
    for (const field of fields) $(field).addEventListener("change", () => renderChart(history));
    renderChart(history);
} catch (error) {
    $("chart-info").textContent = `Unable to load benchmark history: ${error.message}`;
}
