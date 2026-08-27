/**
 * Artifact navigation metadata parser.
 *
 * Pure, dependency-free module. It derives a stable read model from Markdown
 * without rendering it. Markdown is never converted to HTML here, so embedded
 * HTML, scripts, and directives stay inert text that the renderer escapes.
 *
 * Unknown metadata is reported as `null` rather than invented, so a malformed
 * artifact stays viewable without being mistaken for valid workflow state.
 */

import { ArtifactError, ERROR_CODES, LIMITS } from "./artifact-index.mjs";

/** Path-shape classification for the approved tracking roots. */
const TYPE_RULES = Object.freeze([
    { type: "plan-critique", prefix: ".copilot-tracking/reviews/plans/" },
    { type: "review-log", prefix: ".copilot-tracking/reviews/logs/" },
    { type: "research", prefix: ".copilot-tracking/research/" },
    { type: "plan", prefix: ".copilot-tracking/plans/" },
    { type: "phase-details", prefix: ".copilot-tracking/details/" },
    { type: "changes", prefix: ".copilot-tracking/changes/" },
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Artifact filename suffixes stripped when deriving a task slug. */
const SLUG_SUFFIXES = Object.freeze([
    "-plan-critique",
    "-phase-details",
    "-research",
    "-changes",
    "-review",
    "-plan",
]);

/** Classify an artifact by its normalized workspace-relative id. */
export function classifyArtifact(artifactId) {
    for (const rule of TYPE_RULES) {
        if (artifactId.startsWith(rule.prefix)) return rule.type;
    }
    return "unknown";
}

/** Extract the `YYYY-MM-DD` directory segment, when the path carries one. */
export function extractDate(artifactId) {
    const segments = artifactId.split("/");
    for (const segment of segments.slice(0, -1)) {
        if (DATE_PATTERN.test(segment)) return segment;
    }
    return null;
}

/** Derive the task slug from the filename, ignoring the artifact-kind suffix. */
export function extractTaskSlug(artifactId) {
    const filename = artifactId.split("/").pop() ?? "";
    let stem = filename.endsWith(".md") ? filename.slice(0, -3) : filename;
    for (const suffix of SLUG_SUFFIXES) {
        if (stem.endsWith(suffix)) {
            stem = stem.slice(0, -suffix.length);
            break;
        }
    }
    return stem === "" ? null : stem;
}

/**
 * Split a Markdown source into lines while tracking fenced code blocks, so
 * `#` characters inside fences are not mistaken for headings.
 */
function* codeAwareLines(source) {
    let fence = null;
    for (const line of source.split(/\r?\n/)) {
        const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (fence === null) fence = marker;
            else if (fence === marker) fence = null;
            yield { line, inCode: true };
            continue;
        }
        yield { line, inCode: fence !== null };
    }
}

/**
 * Extract the ATX heading outline.
 *
 * Ordinals are assigned in document order so the renderer can address a
 * heading without relying on its text being unique.
 */
export function extractHeadings(source) {
    const headings = [];
    let ordinal = 0;
    for (const { line, inCode } of codeAwareLines(source)) {
        if (inCode) continue;
        const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (match === null) continue;
        ordinal += 1;
        if (ordinal > LIMITS.maxHeadings) {
            throw new ArtifactError(
                ERROR_CODES.headingLimitExceeded,
                `The artifact contains more than ${LIMITS.maxHeadings} headings`,
            );
        }
        headings.push({ ordinal, level: match[1].length, text: match[2].trim() });
    }
    return headings;
}

/** Use the first level-1 heading as the artifact title. */
export function extractTitle(headings) {
    const first = headings.find((heading) => heading.level === 1);
    return first === undefined ? null : first.text;
}

/**
 * Extract a status value from the common RPI metadata shapes.
 *
 * Only bullet metadata lines outside code fences are considered so that
 * narrative prose mentioning "Status" cannot be promoted to workflow state.
 */
export function extractStatus(source) {
    for (const { line, inCode } of codeAwareLines(source)) {
        if (inCode) continue;
        const match = line.match(/^\s*[-*]\s*(?:\*\*)?(Planning status|Execution status|Status)(?:\*\*)?\s*:\s*(.+?)\s*$/i);
        if (match === null) continue;
        const value = match[2].replace(/^\*+|\*+$/g, "").trim();
        if (value !== "") return value;
    }
    return null;
}

/**
 * Build the summary read model for one artifact.
 *
 * `file` is the value returned by `readArtifactFile`.
 */
export function buildArtifactSummary(file, headings = extractHeadings(file.source)) {
    return {
        id: file.id,
        type: classifyArtifact(file.id),
        date: extractDate(file.id),
        taskSlug: extractTaskSlug(file.id),
        title: extractTitle(headings),
        status: extractStatus(file.source),
        modifiedAt: file.modifiedAt,
        sizeBytes: file.sizeBytes,
    };
}

/**
 * Build the full document read model, preserving the exact source text so the
 * renderer can display it escaped and byte-faithful.
 */
export function buildArtifactDocument(file) {
    const headings = extractHeadings(file.source);
    return {
        ...buildArtifactSummary(file, headings),
        sha256: file.sha256,
        headings,
        source: file.source,
    };
}
