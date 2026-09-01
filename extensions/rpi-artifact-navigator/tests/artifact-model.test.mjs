/**
 * Semantic tests for the pure artifact model.
 *
 * Owns path containment, allowlists, deterministic indexing, metadata parsing,
 * hostile content handling, resource limits, and no-write behavior. These tests
 * never import the Copilot SDK and never start a server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, linkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";

import {
    APPROVED_ROOTS,
    ArtifactError,
    ERROR_CODES,
    LIMITS,
    assertResponseWithinLimit,
    discoverArtifactPaths,
    normalizeArtifactId,
    readArtifactFile,
    resolveWorkspaceRoot,
} from "../artifact-index.mjs";
import {
    buildArtifactDocument,
    buildArtifactSummary,
    classifyArtifact,
    extractDate,
    extractHeadings,
    extractStatus,
    extractTaskSlug,
    extractTitle,
} from "../artifact-parser.mjs";

let workspace;

function write(relativePath, contents) {
    const absolute = join(workspace, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
    return absolute;
}

/** Recursively hash every file so a test can prove nothing on disk changed. */
function snapshot(directory) {
    const entries = {};
    const walk = (current) => {
        for (const dirent of readdirSync(current, { withFileTypes: true })) {
            const childPath = join(current, dirent.name);
            if (dirent.isDirectory()) walk(childPath);
            else if (dirent.isFile()) {
                entries[relative(workspace, childPath).split(sep).join("/")] = createHash("sha256")
                    .update(readFileSync(childPath))
                    .digest("hex");
            }
        }
    };
    walk(directory);
    return entries;
}

async function expectCode(promise, code) {
    let thrown;
    try {
        await promise;
    } catch (err) {
        thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArtifactError);
    expect(thrown.code).toBe(code);
    return thrown;
}

beforeEach(async () => {
    workspace = await realpath(mkdtempSync(join(tmpdir(), "rpi-artifact-model-")));
});

afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
});

describe("workspace resolution", () => {
    test("resolves an existing workspace to its real path", async () => {
        expect(await resolveWorkspaceRoot(workspace)).toBe(workspace);
    });

    test("rejects an absent workspace path", async () => {
        await expectCode(resolveWorkspaceRoot(undefined), ERROR_CODES.workspaceUnavailable);
        await expectCode(resolveWorkspaceRoot("   "), ERROR_CODES.workspaceUnavailable);
    });

    test("rejects a workspace path that does not exist", async () => {
        await expectCode(resolveWorkspaceRoot(join(workspace, "absent")), ERROR_CODES.workspaceUnavailable);
    });
});

describe("artifact id policy", () => {
    const validId = ".copilot-tracking/plans/2026-08-27/example-plan.md";

    test("accepts an allowed id under each approved root", () => {
        for (const root of APPROVED_ROOTS) {
            expect(normalizeArtifactId(`${root}/2026-08-27/example-plan.md`)).toBe(`${root}/2026-08-27/example-plan.md`);
        }
    });

    test("rejects non-string and empty ids", () => {
        for (const candidate of [undefined, null, 42, {}, [], ""]) {
            expect(() => normalizeArtifactId(candidate)).toThrow(ArtifactError);
        }
    });

    test.each([
        [".copilot-tracking/plans/../../../etc/passwd.md", ERROR_CODES.artifactIdInvalid],
        [".copilot-tracking/plans/./example-plan.md", ERROR_CODES.artifactIdInvalid],
        [".copilot-tracking/plans//example-plan.md", ERROR_CODES.artifactIdInvalid],
        ["/etc/passwd.md", ERROR_CODES.artifactIdInvalid],
        ["C:/Windows/system.md", ERROR_CODES.artifactIdInvalid],
        [".copilot-tracking\\plans\\example-plan.md", ERROR_CODES.artifactIdInvalid],
        [".copilot-tracking/plans/example\u0000.md", ERROR_CODES.artifactIdInvalid],
        [".copilot-tracking/plans/example-plan.txt", ERROR_CODES.artifactNotAllowed],
        ["README.md", ERROR_CODES.artifactNotAllowed],
        [".copilot-tracking/secrets/example.md", ERROR_CODES.artifactNotAllowed],
        [".copilot-tracking/plans-evil/example.md", ERROR_CODES.artifactNotAllowed],
        [".copilot-tracking/reviews/other/example.md", ERROR_CODES.artifactNotAllowed],
    ])("rejects %s", (candidate, code) => {
        let thrown;
        try {
            normalizeArtifactId(candidate);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ArtifactError);
        expect(thrown.code).toBe(code);
    });

    test("rejection messages never disclose absolute paths", () => {
        try {
            normalizeArtifactId("/etc/passwd.md");
        } catch (err) {
            expect(err.message).not.toContain("/etc/passwd");
        }
        expect(validId).toBe(normalizeArtifactId(validId));
    });
});

describe("discovery", () => {
    test("returns an empty index when .copilot-tracking is absent", async () => {
        expect(await discoverArtifactPaths(workspace)).toEqual([]);
    });

    test("returns normalized workspace-relative ids sorted ascending", async () => {
        write(".copilot-tracking/plans/2026-08-27/b-plan.md", "# B");
        write(".copilot-tracking/plans/2026-08-27/a-plan.md", "# A");
        write(".copilot-tracking/research/2026-08-27/c-research.md", "# C");

        const paths = await discoverArtifactPaths(workspace);
        expect(paths).toEqual([
            ".copilot-tracking/plans/2026-08-27/a-plan.md",
            ".copilot-tracking/plans/2026-08-27/b-plan.md",
            ".copilot-tracking/research/2026-08-27/c-research.md",
        ]);
        for (const id of paths) expect(id.startsWith("/")).toBe(false);
    });

    test("is deterministic across repeated scans", async () => {
        for (let i = 0; i < 12; i++) write(`.copilot-tracking/changes/2026-08-27/item-${i}-changes.md`, `# ${i}`);
        expect(await discoverArtifactPaths(workspace)).toEqual(await discoverArtifactPaths(workspace));
    });

    test("ignores non-Markdown files, directories, and out-of-scope roots", async () => {
        write(".copilot-tracking/plans/2026-08-27/valid-plan.md", "# Valid");
        write(".copilot-tracking/plans/2026-08-27/notes.txt", "ignored");
        write(".copilot-tracking/secrets/2026-08-27/secret.md", "ignored");
        write("README.md", "ignored");
        mkdirSync(join(workspace, ".copilot-tracking/plans/2026-08-27/nested.md"), { recursive: true });

        expect(await discoverArtifactPaths(workspace)).toEqual([".copilot-tracking/plans/2026-08-27/valid-plan.md"]);
    });

    test("skips symlinked files, symlinked directories, and symlinked roots", async () => {
        write(".copilot-tracking/plans/2026-08-27/valid-plan.md", "# Valid");
        const outside = mkdtempSync(join(tmpdir(), "rpi-outside-"));
        writeFileSync(join(outside, "secret-plan.md"), "# Secret");

        symlinkSync(join(outside, "secret-plan.md"), join(workspace, ".copilot-tracking/plans/2026-08-27/link-plan.md"));
        symlinkSync(outside, join(workspace, ".copilot-tracking/plans/2026-08-27/linkdir"));
        symlinkSync(outside, join(workspace, ".copilot-tracking/details"));

        expect(await discoverArtifactPaths(workspace)).toEqual([".copilot-tracking/plans/2026-08-27/valid-plan.md"]);
        rmSync(outside, { recursive: true, force: true });
    });

    test("accepts exactly maxArtifacts and rejects one more", async () => {
        for (let i = 0; i < LIMITS.maxArtifacts; i++) {
            write(`.copilot-tracking/plans/2026-08-27/p${String(i).padStart(4, "0")}-plan.md`, "# P");
        }
        expect((await discoverArtifactPaths(workspace)).length).toBe(LIMITS.maxArtifacts);

        write(".copilot-tracking/plans/2026-08-27/p9999-plan.md", "# P");
        await expectCode(discoverArtifactPaths(workspace), ERROR_CODES.artifactLimitExceeded);
    });
});

describe("artifact reads", () => {
    test("returns exact source, size, hash, and modification time", async () => {
        const contents = "# Example\n\nBody text.\n";
        write(".copilot-tracking/plans/2026-08-27/example-plan.md", contents);

        const file = await readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/example-plan.md");
        expect(file.source).toBe(contents);
        expect(file.sizeBytes).toBe(Buffer.byteLength(contents));
        expect(file.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
        expect(Number.isNaN(Date.parse(file.modifiedAt))).toBe(false);
    });

    test("rejects a missing artifact", async () => {
        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/absent-plan.md"),
            ERROR_CODES.artifactNotFound,
        );
    });

    test("rejects a deleted artifact after it was discovered", async () => {
        const path = write(".copilot-tracking/plans/2026-08-27/temp-plan.md", "# Temp");
        expect((await discoverArtifactPaths(workspace)).length).toBe(1);
        rmSync(path);
        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/temp-plan.md"),
            ERROR_CODES.artifactNotFound,
        );
    });

    test("rejects a directory that ends in .md", async () => {
        mkdirSync(join(workspace, ".copilot-tracking/plans/2026-08-27/dir-plan.md"), { recursive: true });
        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/dir-plan.md"),
            ERROR_CODES.artifactNotFile,
        );
    });

    test("rejects a symlinked artifact and a symlinked intermediate directory", async () => {
        const outside = mkdtempSync(join(tmpdir(), "rpi-outside-read-"));
        writeFileSync(join(outside, "secret-plan.md"), "# Secret");
        mkdirSync(join(workspace, ".copilot-tracking/plans/2026-08-27"), { recursive: true });
        symlinkSync(join(outside, "secret-plan.md"), join(workspace, ".copilot-tracking/plans/2026-08-27/link-plan.md"));
        symlinkSync(outside, join(workspace, ".copilot-tracking/plans/2026-08-27/linkdir"));

        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/link-plan.md"),
            ERROR_CODES.artifactNotAllowed,
        );
        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/linkdir/secret-plan.md"),
            ERROR_CODES.artifactNotAllowed,
        );
        rmSync(outside, { recursive: true, force: true });
    });

    test("rejects a symlink that resolves back inside the workspace", async () => {
        write(".copilot-tracking/plans/2026-08-27/real-plan.md", "# Real");
        symlinkSync(
            join(workspace, ".copilot-tracking/plans/2026-08-27/real-plan.md"),
            join(workspace, ".copilot-tracking/plans/2026-08-27/alias-plan.md"),
        );
        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/alias-plan.md"),
            ERROR_CODES.artifactNotAllowed,
        );
    });

    test("rejects a FIFO named .md instead of blocking on the open", async () => {
        // Without O_NONBLOCK the open of a writerless FIFO never returns, so
        // the closed taxonomy's artifact_not_file is unreachable.
        mkdirSync(join(workspace, ".copilot-tracking/plans/2026-08-27"), { recursive: true });
        const fifoPath = join(workspace, ".copilot-tracking/plans/2026-08-27/pipe-plan.md");
        execFileSync("mkfifo", [fifoPath]);

        const watchdog = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("readArtifactFile did not return")), 5000).unref?.();
        });
        await Promise.race([
            expectCode(
                readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/pipe-plan.md"),
                ERROR_CODES.artifactNotFile,
            ),
            watchdog,
        ]);
    });

    test("rejects a hard link, which aliases an out-of-tree inode without a symlink", async () => {
        const outside = mkdtempSync(join(tmpdir(), "rpi-outside-link-"));
        writeFileSync(join(outside, "secret.md"), "# Secret");
        mkdirSync(join(workspace, ".copilot-tracking/plans/2026-08-27"), { recursive: true });
        try {
            linkSync(join(outside, "secret.md"), join(workspace, ".copilot-tracking/plans/2026-08-27/hard-plan.md"));
        } catch {
            rmSync(outside, { recursive: true, force: true });
            return; // Cross-device link; the alias is not constructible here.
        }
        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/hard-plan.md"),
            ERROR_CODES.artifactNotAllowed,
        );
        rmSync(outside, { recursive: true, force: true });
    });

    test("rejects an intermediate directory replaced by an escaping symlink after the segment walk", async () => {
        // Models the substitution window the lexical walk cannot close: the
        // walk sees a real directory, and the open resolves through a symlink.
        const outside = mkdtempSync(join(tmpdir(), "rpi-outside-swap-"));
        mkdirSync(join(outside, "2026-08-27"), { recursive: true });
        writeFileSync(join(outside, "2026-08-27", "swap-plan.md"), "# Out of tree");

        const datedDir = join(workspace, ".copilot-tracking/plans/2026-08-27");
        write(".copilot-tracking/plans/2026-08-27/swap-plan.md", "# In tree");

        rmSync(datedDir, { recursive: true, force: true });
        symlinkSync(join(outside, "2026-08-27"), datedDir);

        await expectCode(
            readArtifactFile(workspace, ".copilot-tracking/plans/2026-08-27/swap-plan.md"),
            ERROR_CODES.artifactNotAllowed,
        );
        rmSync(outside, { recursive: true, force: true });
    });

    test("never returns out-of-tree content while an intermediate directory is swapped under it", async () => {
        // The lexical walk cannot close this window on its own, because `open`
        // resolves the path again. Churn the substitution against concurrent
        // reads and assert the out-of-tree body is never returned.
        const outside = mkdtempSync(join(tmpdir(), "rpi-outside-churn-"));
        mkdirSync(join(outside, "2026-08-27"), { recursive: true });
        writeFileSync(join(outside, "2026-08-27", "churn-plan.md"), "# OUT OF TREE");

        const id = ".copilot-tracking/plans/2026-08-27/churn-plan.md";
        const datedDir = join(workspace, ".copilot-tracking/plans/2026-08-27");
        write(id, "# IN TREE");

        for (let round = 0; round < 40; round++) {
            const swap = (async () => {
                rmSync(datedDir, { recursive: true, force: true });
                symlinkSync(join(outside, "2026-08-27"), datedDir);
                rmSync(datedDir, { recursive: true, force: true });
                mkdirSync(datedDir, { recursive: true });
                writeFileSync(join(datedDir, "churn-plan.md"), "# IN TREE");
            })();
            const read = readArtifactFile(workspace, id).catch((err) => err);
            const [result] = await Promise.all([read, swap]);
            if (!(result instanceof Error)) {
                expect(result.source).toBe("# IN TREE");
            } else {
                expect(result).toBeInstanceOf(ArtifactError);
            }
        }
        rmSync(outside, { recursive: true, force: true });
    });

    test("never returns a mix of a replaced file's bytes", async () => {
        const id = ".copilot-tracking/plans/2026-08-27/race-plan.md";
        const path = write(id, "# Original");
        const original = "# Original";
        const replacement = "# Replacement content that is deliberately longer";

        const readPromise = readArtifactFile(workspace, id);
        rmSync(path);
        writeFileSync(path, replacement);

        let result;
        let failure;
        try {
            result = await readPromise;
        } catch (err) {
            failure = err;
        }
        if (failure !== undefined) {
            expect(failure).toBeInstanceOf(ArtifactError);
            expect(failure.code).toBe(ERROR_CODES.artifactChanged);
        } else {
            // A successful read must be a consistent snapshot of exactly one of
            // the two files, never a blend of both.
            expect([original, replacement]).toContain(result.source);
            expect(result.sizeBytes).toBe(Buffer.byteLength(result.source));
            expect(result.sha256).toBe(createHash("sha256").update(result.source).digest("hex"));
        }
    });

    test("repeated check-and-use replacement always yields a consistent snapshot or artifact_changed", async () => {
        const id = ".copilot-tracking/plans/2026-08-27/churn-plan.md";
        const path = write(id, "# V0");
        const variants = new Set(["# V0"]);

        for (let round = 1; round <= 25; round++) {
            const next = `# V${round}${"x".repeat(round * 8)}`;
            variants.add(next);
            const readPromise = readArtifactFile(workspace, id);
            rmSync(path, { force: true });
            writeFileSync(path, next);

            try {
                const file = await readPromise;
                expect(variants).toContain(file.source);
                expect(file.sha256).toBe(createHash("sha256").update(file.source).digest("hex"));
            } catch (err) {
                expect(err).toBeInstanceOf(ArtifactError);
                expect([ERROR_CODES.artifactChanged, ERROR_CODES.artifactNotFound]).toContain(err.code);
            }
        }
    });

    test("accepts a file at the size limit and rejects one byte over", async () => {
        const underId = ".copilot-tracking/plans/2026-08-27/under-plan.md";
        const atId = ".copilot-tracking/plans/2026-08-27/at-plan.md";
        const overId = ".copilot-tracking/plans/2026-08-27/over-plan.md";
        write(underId, "a".repeat(LIMITS.maxFileBytes - 1));
        write(atId, "a".repeat(LIMITS.maxFileBytes));
        write(overId, "a".repeat(LIMITS.maxFileBytes + 1));

        expect((await readArtifactFile(workspace, underId)).sizeBytes).toBe(LIMITS.maxFileBytes - 1);
        expect((await readArtifactFile(workspace, atId)).sizeBytes).toBe(LIMITS.maxFileBytes);
        await expectCode(readArtifactFile(workspace, overId), ERROR_CODES.artifactTooLarge);
    });

    test("reads leave every workspace file byte-identical", async () => {
        write(".copilot-tracking/plans/2026-08-27/a-plan.md", "# A\n");
        write(".copilot-tracking/research/2026-08-27/b-research.md", "# B\n");
        const before = snapshot(workspace);

        for (const id of await discoverArtifactPaths(workspace)) {
            const file = await readArtifactFile(workspace, id);
            buildArtifactDocument(file);
        }

        expect(snapshot(workspace)).toEqual(before);
    });
});

describe("metadata parsing", () => {
    test.each([
        [".copilot-tracking/research/2026-08-27/x-research.md", "research"],
        [".copilot-tracking/plans/2026-08-27/x-plan.md", "plan"],
        [".copilot-tracking/details/2026-08-27/x-phase-details.md", "phase-details"],
        [".copilot-tracking/changes/2026-08-27/x-changes.md", "changes"],
        [".copilot-tracking/reviews/plans/2026-08-27/x-plan-critique.md", "plan-critique"],
        [".copilot-tracking/reviews/logs/2026-08-27/x-review.md", "review-log"],
        ["some/other/path.md", "unknown"],
    ])("classifies %s as %s", (id, expected) => {
        expect(classifyArtifact(id)).toBe(expected);
    });

    test("extracts date and task slug, and reports unknowns as null", () => {
        expect(extractDate(".copilot-tracking/plans/2026-08-27/my-task-plan.md")).toBe("2026-08-27");
        expect(extractDate(".copilot-tracking/plans/my-task-plan.md")).toBeNull();
        expect(extractTaskSlug(".copilot-tracking/plans/2026-08-27/my-task-plan.md")).toBe("my-task");
        expect(extractTaskSlug(".copilot-tracking/details/2026-08-27/my-task-phase-details.md")).toBe("my-task");
        expect(extractTaskSlug(".copilot-tracking/reviews/plans/2026-08-27/my-task-plan-critique.md")).toBe("my-task");
    });

    test("extracts a nested heading outline with document-order ordinals", () => {
        const headings = extractHeadings("# One\n\n## Two\n\n### Three\n\n## Four\n");
        expect(headings).toEqual([
            { ordinal: 1, level: 1, text: "One", line: 0 },
            { ordinal: 2, level: 2, text: "Two", line: 2 },
            { ordinal: 3, level: 3, text: "Three", line: 4 },
            { ordinal: 4, level: 2, text: "Four", line: 6 },
        ]);
        expect(extractTitle(headings)).toBe("One");
    });

    test("reports the exact source line for every heading, including after fences", () => {
        const source = "intro\n# One\n\n```\n# hidden\n```\n\n## Two\n";
        const headings = extractHeadings(source);
        const lines = source.split("\n");
        expect(headings.map((h) => h.text)).toEqual(["One", "Two"]);
        for (const heading of headings) {
            expect(lines[heading.line]).toContain(heading.text);
        }
    });

    test("ignores headings inside fenced code blocks", () => {
        const headings = extractHeadings("# Real\n\n```\n# Not a heading\n```\n\n## Also real\n");
        expect(headings.map((h) => h.text)).toEqual(["Real", "Also real"]);
    });

    test("does not let a shorter fence close a longer one", () => {
        // A three-backtick line inside a four-backtick block is content, not a
        // close, so nothing inside may leak out and nothing after may be lost.
        const source = ["# Real", "", "````", "```", "# Leaked heading", "````", "", "## Real Two", ""].join("\n");
        expect(extractHeadings(source).map((h) => h.text)).toEqual(["Real", "Real Two"]);
    });

    test("closes a fence on a longer run of the same character", () => {
        const source = ["```", "# hidden", "`````", "# Visible", ""].join("\n");
        expect(extractHeadings(source).map((h) => h.text)).toEqual(["Visible"]);
    });

    test("does not let a tilde fence close a backtick fence", () => {
        const source = ["```", "~~~", "# hidden", "```", "# Visible", ""].join("\n");
        expect(extractHeadings(source).map((h) => h.text)).toEqual(["Visible"]);
    });

    test("keeps an info string out of the closing rule", () => {
        const source = ["```markdown", "# hidden", "```", "# Visible", ""].join("\n");
        expect(extractHeadings(source).map((h) => h.text)).toEqual(["Visible"]);
    });

    test("rejects a closing fence that carries trailing content", () => {
        const source = ["```", "# hidden", "``` not a close", "# still hidden", "```", "# Visible", ""].join("\n");
        expect(extractHeadings(source).map((h) => h.text)).toEqual(["Visible"]);
    });

    test("treats a backtick fence whose info string holds a backtick as ordinary text", () => {
        // CommonMark forbids a backtick in the info string of a backtick fence,
        // so the line opens nothing and the heading after it stays visible.
        const source = ["``` a`b", "# Visible", ""].join("\n");
        expect(extractHeadings(source).map((h) => h.text)).toEqual(["Visible"]);
    });

    test("keeps every current tracking artifact's outline stable", async () => {
        // Guards the parser against regressions on the shapes this repository
        // actually produces, independent of the synthetic cases above.
        const root = await realpath(process.cwd());
        const ids = await discoverArtifactPaths(root);
        for (const id of ids) {
            const file = await readArtifactFile(root, id);
            const headings = extractHeadings(file.source);
            const lines = file.source.split(/\r?\n/);
            for (const heading of headings) {
                expect(lines[heading.line]).toMatch(/^#{1,6}\s/);
            }
        }
    });

    test("extracts status from common metadata shapes and returns null when absent", () => {
        expect(extractStatus("* Planning status: Ready\n")).toBe("Ready");
        expect(extractStatus("- **Status**: Blocked\n")).toBe("Blocked");
        expect(extractStatus("* Execution status: Partial\n")).toBe("Partial");
        expect(extractStatus("* Critique execution status: Complete\n", "plan-critique")).toBe("Complete");
        expect(extractStatus("* Execution status: Complete.\n")).toBe("Complete");
        expect(extractStatus("* Execution status: Complete?!\n")).toBe("Complete");
        expect(extractStatus("* Critique execution status: Complete\n")).toBeNull();
        expect(extractStatus("Some prose mentioning Status: not metadata\n")).toBeNull();
        expect(extractStatus("# Title only\n")).toBeNull();
    });

    test("derives phase-details status from the first incomplete phase-index row", () => {
        const complete = [
            "## Phase Index",
            "",
            "| Phase ID | Name | Status | Detail sections |",
            "|---|---|---|---|",
            "| P01 | First | Complete | P01 |",
        ].join("\n");
        expect(extractStatus(complete, "phase-details")).toBe("Complete");

        const mixed = `${complete}\n| P02 | Second | Ready. | P02 |`;
        expect(extractStatus(mixed, "phase-details")).toBe("Ready");
        expect(extractStatus(mixed)).toBeNull();

        const noTrailingPipes = [
            "## Phase Index",
            "",
            "| Phase ID | Name | Status",
            "|---|---|---",
            "| P01 | First | Complete",
        ].join("\n");
        expect(extractStatus(noTrailingPipes, "phase-details")).toBe("Complete");
    });

    test("builds statuses from critique and phase-details artifact contracts", () => {
        const summary = (id, source) =>
            buildArtifactSummary({
                id,
                source,
                sizeBytes: Buffer.byteLength(source),
                modifiedAt: "2026-08-27T12:00:00.000Z",
                sha256: "abc",
            });
        expect(
            summary(
                ".copilot-tracking/reviews/plans/2026-08-27/example-plan-critique.md",
                "# Critique\n\n* Critique execution status: Complete\n",
            ).status,
        ).toBe("Complete");
        expect(
            summary(
                ".copilot-tracking/details/2026-08-27/example-phase-details.md",
                "# Details\n\n## Phase Index\n\n| Phase | Status |\n|---|---|\n| P01 | Complete |\n",
            ).status,
        ).toBe("Complete");
    });

    test("keeps a malformed artifact viewable with unknown metadata", () => {
        const document = buildArtifactDocument({
            id: "some/other/path.md",
            source: "no headings, no metadata",
            sizeBytes: 24,
            modifiedAt: "2026-08-27T12:00:00.000Z",
            sha256: "abc",
        });
        expect(document.type).toBe("unknown");
        expect(document.date).toBeNull();
        expect(document.title).toBeNull();
        expect(document.status).toBeNull();
        expect(document.headings).toEqual([]);
        expect(document.source).toBe("no headings, no metadata");
    });

    test("leaves embedded HTML and scripts as inert source text", () => {
        const hostile = '# Title\n\n<script>alert("x")</script>\n<img src=x onerror="alert(1)">\n\n<!-- comment -->\n';
        const document = buildArtifactDocument({
            id: ".copilot-tracking/plans/2026-08-27/hostile-plan.md",
            source: hostile,
            sizeBytes: Buffer.byteLength(hostile),
            modifiedAt: "2026-08-27T12:00:00.000Z",
            sha256: "abc",
        });
        expect(document.source).toBe(hostile);
        expect(document.headings.map((h) => h.text)).toEqual(["Title"]);
        expect(typeof document.source).toBe("string");
    });

    test("accepts exactly maxHeadings and rejects one more", () => {
        const at = Array.from({ length: LIMITS.maxHeadings }, (_, i) => `# H${i}`).join("\n");
        const over = `${at}\n# Overflow`;
        expect(extractHeadings(at).length).toBe(LIMITS.maxHeadings);

        let thrown;
        try {
            extractHeadings(over);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ArtifactError);
        expect(thrown.code).toBe(ERROR_CODES.headingLimitExceeded);
    });

    test("summary shape matches the action contract", () => {
        const summary = buildArtifactSummary({
            id: ".copilot-tracking/plans/2026-08-27/example-plan.md",
            source: "# Example\n\n* Planning status: Ready\n",
            sizeBytes: 34,
            modifiedAt: "2026-08-27T12:00:00.000Z",
            sha256: "abc",
        });
        expect(Object.keys(summary).sort()).toEqual(
            ["date", "id", "modifiedAt", "sizeBytes", "status", "taskSlug", "title", "type"].sort(),
        );
        expect(summary).toMatchObject({ type: "plan", date: "2026-08-27", taskSlug: "example", status: "Ready" });
    });
});

describe("response ceiling", () => {
    test("accepts payloads at the limit and rejects payloads above it", () => {
        const fill = (bytes) => ({ source: "a".repeat(bytes) });
        const overhead = JSON.stringify(fill(0)).length;

        expect(() => assertResponseWithinLimit(fill(LIMITS.maxResponseBytes - overhead - 1))).not.toThrow();
        expect(() => assertResponseWithinLimit(fill(LIMITS.maxResponseBytes - overhead))).not.toThrow();

        let thrown;
        try {
            assertResponseWithinLimit(fill(LIMITS.maxResponseBytes - overhead + 1));
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ArtifactError);
        expect(thrown.code).toBe(ERROR_CODES.responseTooLarge);
    });
});

describe("no-write behavior", () => {
    test("the module never opens a file for writing", () => {
        const source = readFileSync(new URL("../artifact-index.mjs", import.meta.url), "utf8");
        for (const forbidden of ["writeFile", "appendFile", "createWriteStream", "unlink", "mkdir", "rename"]) {
            expect(source).not.toContain(forbidden);
        }
        expect(source).toContain("O_RDONLY");
    });

    test("discovery does not create the approved roots", async () => {
        await discoverArtifactPaths(workspace);
        expect(() => statSync(join(workspace, ".copilot-tracking"))).toThrow();
    });
});
