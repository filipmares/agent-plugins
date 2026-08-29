/**
 * Plugin, marketplace, and distribution contract tests.
 *
 * Owns marketplace and plugin manifest parity, path containment, declared
 * extension entry points, canvas and action uniqueness, reserved names, and
 * the boundary that keeps the repository's existing skills.sh distribution
 * unchanged by this companion plugin.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const pluginDir = join(repoRoot, "plugins", "hve-core-canvas");
const extensionDir = join(repoRoot, "extensions", "rpi-artifact-navigator");
const pluginExtensionDir = join(pluginDir, "extensions", "rpi-artifact-navigator");

const { validateCopilotPlugin, extractCanvasDeclarations } = await import(
    join(repoRoot, "scripts", "validate-copilot-plugin.ts")
);

const marketplace = JSON.parse(readFileSync(join(repoRoot, ".github", "plugin", "marketplace.json"), "utf8"));
const pluginManifest = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

/** Build a throwaway repository shaped like the real one, then validate it. */
function validateFixture(build) {
    const root = mkdtempSync(join(tmpdir(), "rpi-plugin-contract-"));
    try {
        mkdirSync(join(root, ".github", "plugin"), { recursive: true });
        build(root);
        return validateCopilotPlugin(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function writeFixture(root, { marketplaceJson, pluginJson, entry, omitEntry = false, extensionSubdir = "demo-ext" }) {
    writeFileSync(join(root, ".github", "plugin", "marketplace.json"), JSON.stringify(marketplaceJson));
    if (pluginJson === undefined) return;
    const dir = join(root, "plugins", "demo");
    mkdirSync(join(dir, "extensions", extensionSubdir), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(pluginJson));
    if (!omitEntry) {
        writeFileSync(
            join(dir, "extensions", extensionSubdir, "extension.mjs"),
            entry ?? 'import { createCanvas } from "x";\ncreateCanvas({ id: "demo", actions: [{ name: "a" }] });\n',
        );
    }
}

const baseMarketplace = {
    name: "smoke",
    plugins: [{ name: "demo", source: "./plugins/demo", version: "1.0.0", description: "Demo plugin" }],
};
const basePlugin = { name: "demo", version: "1.0.0", extensions: "extensions/demo-ext" };

describe("repository marketplace and plugin manifests", () => {
    test("the repository marketplace validates", () => {
        const results = validateCopilotPlugin(repoRoot);
        expect(results.errors).toEqual([]);
        expect(results.valid).toBe(true);
        expect(results.marketplaceName).toBe("agent-plugins");
        expect(results.pluginNames).toContain("hve-core-canvas");
    });

    test("the companion entry declares the expected source and metadata", () => {
        const entry = marketplace.plugins.find((plugin) => plugin.name === "hve-core-canvas");
        expect(entry).toBeDefined();
        expect(entry.source).toBe("./plugins/hve-core-canvas");
        expect(entry.version).toBe(pluginManifest.version);
        expect(entry.license).toBe("MIT");
        expect(entry.description).toContain("read-only");
    });

    test("the plugin manifest declares only the navigator extension", () => {
        expect(pluginManifest.name).toBe("hve-core-canvas");
        expect(pluginManifest.extensions).toBe("extensions/rpi-artifact-navigator");
        for (const implicit of ["skills", "agents", "commands", "rules", "hooks"]) {
            expect(pluginManifest[implicit]).toBeUndefined();
        }
    });

    test("the plugin package ships its entry point, license, and documentation", () => {
        expect(existsSync(join(pluginExtensionDir, "extension.mjs"))).toBe(true);
        expect(JSON.parse(readFileSync(join(extensionDir, "copilot-extension.json"), "utf8"))).toEqual({
            name: "rpi-artifact-navigator",
            version: 1,
        });
        expect(readFileSync(join(pluginExtensionDir, "extension.mjs"), "utf8")).toBe(
            readFileSync(join(extensionDir, "extension.mjs"), "utf8"),
        );
        expect(existsSync(join(pluginDir, "LICENSE"))).toBe(true);
        expect(existsSync(join(pluginDir, "README.md"))).toBe(true);
    });

});

describe("declared canvas surface", () => {
    const declarations = extractCanvasDeclarations(readFileSync(join(extensionDir, "extension.mjs"), "utf8"));

    test("declares exactly one canvas with the pilot id", () => {
        expect(declarations.length).toBe(1);
        expect(declarations[0].id).toBe("rpi-artifact-navigator");
    });

    test("declares exactly the three contract actions with unique, unreserved names", () => {
        const names = declarations[0].actionNames;
        expect(names).toEqual(["list_rpi_artifacts", "get_rpi_artifact", "refresh_rpi_artifacts"]);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name.startsWith("canvas.")).toBe(false);
    });

    test("the extension declares no dependency beyond the SDK and Node builtins", () => {
        for (const file of ["extension.mjs", "server.mjs", "renderer.mjs", "artifact-index.mjs", "artifact-parser.mjs"]) {
            const source = readFileSync(join(extensionDir, file), "utf8");
            for (const match of source.matchAll(/^import\s+[^;]*?from\s+["']([^"']+)["']/gm)) {
                const specifier = match[1];
                const allowed =
                    specifier.startsWith("node:") ||
                    specifier.startsWith("./") ||
                    specifier.startsWith("@github/copilot-sdk");
                expect(allowed).toBe(true);
            }
        }
        expect(existsSync(join(extensionDir, "package.json"))).toBe(false);
        expect(existsSync(join(pluginDir, "node_modules"))).toBe(false);
    });

    test("no extension module opens a network listener beyond loopback", () => {
        const server = readFileSync(join(extensionDir, "server.mjs"), "utf8");
        expect(server).toContain('server.listen(0, "127.0.0.1"');
        expect(server).not.toContain("0.0.0.0");
        expect(server).not.toContain("::");
        for (const file of ["extension.mjs", "renderer.mjs", "artifact-index.mjs", "artifact-parser.mjs"]) {
            expect(readFileSync(join(extensionDir, file), "utf8")).not.toContain("listen(");
        }
    });

    test("no extension module executes commands", () => {
        const forbidden = ["child_process", "execSync", "spawn(", "node:vm"];
        for (const file of ["extension.mjs", "server.mjs", "renderer.mjs", "artifact-index.mjs", "artifact-parser.mjs"]) {
            const source = readFileSync(join(extensionDir, file), "utf8");
            for (const term of forbidden) expect(source).not.toContain(term);
        }
    });
});

describe("validator rejection classes", () => {
    test("accepts a well-formed fixture", () => {
        const results = validateFixture((root) =>
            writeFixture(root, { marketplaceJson: baseMarketplace, pluginJson: basePlugin }),
        );
        expect(results.errors).toEqual([]);
        expect(results.valid).toBe(true);
    });

    test("rejects unparseable marketplace JSON", () => {
        const results = validateFixture((root) => {
            writeFileSync(join(root, ".github", "plugin", "marketplace.json"), "{ not json");
        });
        expect(results.valid).toBe(false);
        expect(results.errors[0]).toContain("not valid JSON");
    });

    test("rejects a missing marketplace file", () => {
        const results = validateFixture(() => {});
        expect(results.errors).toEqual(["Missing .github/plugin/marketplace.json"]);
    });

    test("rejects missing or malformed entry metadata", () => {
        const cases = [
            [{ source: "./plugins/demo", version: "1.0.0", description: "d" }, 'lowercase hyphenated "name"'],
            [{ name: "Demo", source: "./plugins/demo", version: "1.0.0", description: "d" }, 'lowercase hyphenated "name"'],
            [{ name: "demo", source: "./plugins/demo", version: "not-semver", description: "d" }, 'semver "version"'],
            [{ name: "demo", source: "./plugins/demo", version: "1.0.0", description: "  " }, 'non-empty "description"'],
            [{ name: "demo", version: "1.0.0", description: "d" }, 'non-empty "source"'],
        ];
        for (const [entry, expected] of cases) {
            const results = validateFixture((root) =>
                writeFixture(root, { marketplaceJson: { name: "smoke", plugins: [entry] }, pluginJson: basePlugin }),
            );
            expect(results.valid).toBe(false);
            expect(results.errors.join(" ")).toContain(expected);
        }
    });

    test("rejects a source that escapes the repository", () => {
        const results = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: {
                    name: "smoke",
                    plugins: [{ name: "demo", source: "../outside", version: "1.0.0", description: "d" }],
                },
            }),
        );
        expect(results.errors.join(" ")).toContain("escapes the repository");
    });

    test("rejects a plugin directory with no manifest", () => {
        const results = validateFixture((root) => {
            writeFileSync(join(root, ".github", "plugin", "marketplace.json"), JSON.stringify(baseMarketplace));
            mkdirSync(join(root, "plugins", "demo"), { recursive: true });
        });
        expect(results.errors.join(" ")).toContain("has no plugin.json");
    });

    test("rejects a name or version mismatch between manifest and marketplace", () => {
        const nameMismatch = validateFixture((root) =>
            writeFixture(root, { marketplaceJson: baseMarketplace, pluginJson: { ...basePlugin, name: "other" } }),
        );
        expect(nameMismatch.errors.join(" ")).toContain("does not match marketplace entry name");

        const versionMismatch = validateFixture((root) =>
            writeFixture(root, { marketplaceJson: baseMarketplace, pluginJson: { ...basePlugin, version: "9.9.9" } }),
        );
        expect(versionMismatch.errors.join(" ")).toContain("version mismatch");
    });

    test("rejects extension paths that escape, are absent, or lack extension.mjs", () => {
        const escaping = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: baseMarketplace,
                pluginJson: { ...basePlugin, extensions: "../../escape" },
            }),
        );
        expect(escaping.errors.join(" ")).toContain("escapes the plugin directory");

        const absent = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: baseMarketplace,
                pluginJson: { ...basePlugin, extensions: "extensions/not-there" },
            }),
        );
        expect(absent.errors.join(" ")).toContain("not an existing directory");

        const missingEntry = validateFixture((root) =>
            writeFixture(root, { marketplaceJson: baseMarketplace, pluginJson: basePlugin, omitEntry: true }),
        );
        expect(missingEntry.errors.join(" ")).toContain("missing extension.mjs");

        const badShape = validateFixture((root) =>
            writeFixture(root, { marketplaceJson: baseMarketplace, pluginJson: { ...basePlugin, extensions: 42 } }),
        );
        expect(badShape.errors.join(" ")).toContain("neither a string nor an array");
    });

    test("rejects duplicate plugin names, duplicate canvas ids, duplicate and reserved action names", () => {
        const duplicatePlugins = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: { name: "smoke", plugins: [...baseMarketplace.plugins, ...baseMarketplace.plugins] },
                pluginJson: basePlugin,
            }),
        );
        expect(duplicatePlugins.errors.join(" ")).toContain("duplicate plugin name");

        const duplicateCanvas = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: baseMarketplace,
                pluginJson: basePlugin,
                entry: 'import { createCanvas } from "x";\ncreateCanvas({ id: "demo" });\ncreateCanvas({ id: "demo" });\n',
            }),
        );
        expect(duplicateCanvas.errors.join(" ")).toContain('duplicate canvas id "demo"');

        const duplicateAction = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: baseMarketplace,
                pluginJson: basePlugin,
                entry: 'import { createCanvas } from "x";\ncreateCanvas({ id: "demo", actions: [{ name: "a" }, { name: "a" }] });\n',
            }),
        );
        expect(duplicateAction.errors.join(" ")).toContain('duplicate action name "a"');

        const reserved = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: baseMarketplace,
                pluginJson: basePlugin,
                entry: 'import { createCanvas } from "x";\ncreateCanvas({ id: "demo", actions: [{ name: "canvas.open" }] });\n',
            }),
        );
        expect(reserved.errors.join(" ")).toContain("reserved action name");
    });

    test("rejects a canvas whose id cannot be determined statically", () => {
        const results = validateFixture((root) =>
            writeFixture(root, {
                marketplaceJson: baseMarketplace,
                pluginJson: basePlugin,
                entry: 'import { createCanvas } from "x";\ncreateCanvas({ id: makeId(), actions: [] });\n',
            }),
        );
        expect(results.errors.join(" ")).toContain("without a literal id");
    });
});

describe("static canvas extraction", () => {
    test("ignores the import binding and only reads call sites", () => {
        const declarations = extractCanvasDeclarations(
            'import { joinSession, createCanvas } from "@github/copilot-sdk/extension";\ncreateCanvas({ id: "only" });\n',
        );
        expect(declarations.map((d) => d.id)).toEqual(["only"]);
    });

    test("is not confused by braces or keywords inside strings and comments", () => {
        const source = [
            'import { createCanvas } from "x";',
            '// createCanvas({ id: "commented" })',
            '/* createCanvas({ id: "blocked" }) */',
            'const note = "createCanvas({ id: \\"stringy\\" })";',
            'createCanvas({ id: "real", description: "a } brace { in text", actions: [{ name: "act" }] });',
        ].join("\n");
        const declarations = extractCanvasDeclarations(source);
        expect(declarations.map((d) => d.id)).toEqual(["real"]);
        expect(declarations[0].actionNames).toEqual(["act"]);
    });

    test("does not promote nested schema properties to declaration fields", () => {
        const declarations = extractCanvasDeclarations(
            'import { createCanvas } from "x";\ncreateCanvas({ id: "outer", inputSchema: { properties: { id: { type: "string" } } }, actions: [{ name: "act", inputSchema: { properties: { name: { type: "string" } } } }] });\n',
        );
        expect(declarations).toEqual([{ id: "outer", actionNames: ["act"], unresolvedActions: 0 }]);
    });

    test("resolves a canvas id supplied through a module-level string constant", () => {
        const declarations = extractCanvasDeclarations(
            'import { createCanvas } from "x";\nconst CANVAS_ID = "from-constant";\ncreateCanvas({ id: CANVAS_ID, actions: [{ name: "act" }] });\n',
        );
        expect(declarations).toEqual([{ id: "from-constant", actionNames: ["act"], unresolvedActions: 0 }]);
    });

    test("does not resolve a constant that is only assigned a computed value", () => {
        const declarations = extractCanvasDeclarations(
            'import { createCanvas } from "x";\nconst CANVAS_ID = buildId();\ncreateCanvas({ id: CANVAS_ID });\n',
        );
        expect(declarations).toEqual([{ id: "", actionNames: [], unresolvedActions: 0 }]);
    });

    test("does not fabricate a declaration from a regular-expression literal", () => {
        const declarations = extractCanvasDeclarations(
            ['import { createCanvas } from "x";', 'const pattern = /createCanvas\\({ id: "phantom" }\\)/;', 'createCanvas({ id: "real" });'].join("\n"),
        );
        expect(declarations.map((d) => d.id)).toEqual(["real"]);
    });

    test("does not treat a division as the start of a regular expression", () => {
        const declarations = extractCanvasDeclarations(
            ['import { createCanvas } from "x";', "const ratio = total / count / 2;", 'createCanvas({ id: "real", actions: [{ name: "act" }] });'].join("\n"),
        );
        expect(declarations).toEqual([{ id: "real", actionNames: ["act"], unresolvedActions: 0 }]);
    });

    test("sees a declaration written inside a template-literal expression", () => {
        const declarations = extractCanvasDeclarations(
            ["import { createCanvas } from \"x\";", "const rendered = `prefix ${describe(createCanvas({ id: \"interpolated\" }))} suffix`;"].join("\n"),
        );
        expect(declarations.map((d) => d.id)).toEqual(["interpolated"]);
    });

    test("ignores literal template text that merely looks like a declaration", () => {
        const declarations = extractCanvasDeclarations(
            ["import { createCanvas } from \"x\";", "const doc = `createCanvas({ id: \"documented\" })`;", 'createCanvas({ id: "real" });'].join("\n"),
        );
        expect(declarations.map((d) => d.id)).toEqual(["real"]);
    });

    test("refuses to resolve a mutable or nested binding as a constant", () => {
        const mutable = extractCanvasDeclarations(
            'import { createCanvas } from "x";\nlet CANVAS_ID = "mutable";\ncreateCanvas({ id: CANVAS_ID });\n',
        );
        expect(mutable.map((d) => d.id)).toEqual([""]);

        const nested = extractCanvasDeclarations(
            'import { createCanvas } from "x";\nfunction make() { const CANVAS_ID = "nested"; }\ncreateCanvas({ id: CANVAS_ID });\n',
        );
        expect(nested.map((d) => d.id)).toEqual([""]);
    });

    test("refuses a module-level constant that is shadowed elsewhere", () => {
        const declarations = extractCanvasDeclarations(
            [
                'import { createCanvas } from "x";',
                'const CANVAS_ID = "outer";',
                'function other() { const CANVAS_ID = "inner"; return CANVAS_ID; }',
                "createCanvas({ id: CANVAS_ID });",
            ].join("\n"),
        );
        expect(declarations.map((d) => d.id)).toEqual([""]);
    });

    test("reports an action name it cannot statically prove instead of dropping it", () => {
        const declarations = extractCanvasDeclarations(
            'import { createCanvas } from "x";\ncreateCanvas({ id: "real", actions: [{ name: computeName(), handler: h }, { name: "known" }] });\n',
        );
        expect(declarations[0].actionNames).toEqual(["known"]);
        expect(declarations[0].unresolvedActions).toBe(1);
    });
});

describe("existing distribution boundary", () => {
    test("the root skills directory and its skills.sh layout are untouched", () => {
        const skillsDir = join(repoRoot, "skills");
        expect(existsSync(skillsDir)).toBe(true);

        // Assert the whole tree, not a sample: every skill directory must carry
        // a SKILL.md, and nothing under skills/ may reference the pilot plugin.
        const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        expect(skillDirs.length).toBeGreaterThan(0);

        const files = [];
        const walk = (current) => {
            for (const entry of readdirSync(current, { withFileTypes: true })) {
                const childPath = join(current, entry.name);
                if (entry.isDirectory()) walk(childPath);
                else if (entry.isFile()) files.push(childPath);
            }
        };
        walk(skillsDir);

        for (const skill of skillDirs) {
            expect(existsSync(join(skillsDir, skill, "SKILL.md"))).toBe(true);
        }
        for (const file of files) {
            const relativePath = relative(repoRoot, file).split(sep).join("/");
            expect(relativePath.startsWith("skills/")).toBe(true);
            if (/\.(md|json|ts|js|mjs|ya?ml)$/.test(relativePath)) {
                expect(readFileSync(file, "utf8")).not.toContain("hve-core-canvas");
            }
        }
    });

    test("no commit that touches the companion plugin also touches root skills", () => {
        // The mechanical proof that adopting the pilot left the skills.sh
        // distribution alone, rather than a sample of names still existing.
        let commits;
        try {
            commits = execFileSync("git", ["log", "--format=%H", "--", "plugins/hve-core-canvas"], {
                cwd: repoRoot,
                encoding: "utf8",
            })
                .split("\n")
                .filter((line) => line !== "");
        } catch {
            return; // Not a git checkout; the listing test above still applies.
        }
        for (const commit of commits) {
            const touched = execFileSync("git", ["show", "--name-only", "--format=", commit, "--", "skills"], {
                cwd: repoRoot,
                encoding: "utf8",
            }).trim();
            expect(touched).toBe("");
        }
    });

    test("no root skill lives inside the companion plugin", () => {
        expect(existsSync(join(pluginDir, "skills"))).toBe(false);
    });

    test("the existing marketplace entry for the skills plugin is preserved", () => {
        const entry = marketplace.plugins.find((plugin) => plugin.name === "agent-plugins");
        expect(entry).toBeDefined();
        expect(entry.source).toBe(".");
    });

    test("existing package scripts keep their meaning and the new scripts are additive", () => {
        expect(packageJson.scripts.validate).toBe("bun run scripts/validate-skill.ts");
        expect(packageJson.scripts.list).toBe("bun run scripts/list-skills.ts");
        expect(packageJson.scripts["validate:copilot-plugin"]).toBe("bun run scripts/validate-copilot-plugin.ts");
        expect(packageJson.scripts["test:canvas"]).toBe("bun test extensions/rpi-artifact-navigator/tests/*.test.mjs");
    });
});
