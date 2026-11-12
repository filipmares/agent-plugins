import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const client = dirname(fileURLToPath(import.meta.url));
const root = dirname(client);
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

export async function sourceHash() {
    const hash = createHash("sha256");
    async function walk(directory: string) {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
            if (entry.name === "node_modules") continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.isFile()) {
                hash.update(relative(client, path).replaceAll("\\", "/")).update("\0");
                hash.update((await readFile(path, "utf8")).replaceAll("\r\n", "\n")).update("\0");
            }
        }
    }
    await walk(client);
    return hash.digest("hex");
}

async function build() {
    const vendor = join(root, "vendor");
    const licenses = join(root, "third-party-licenses");
    await mkdir(vendor, { recursive: true });
    await mkdir(licenses, { recursive: true });
    const assets = [];
    for (const name of ["yaml", "markdown"]) {
        const result = await Bun.build({
            entrypoints: [join(client, `${name}.ts`)],
            target: "node",
            format: "esm",
            minify: true,
        });
        if (!result.success) throw new AggregateError(result.logs, `Could not build ${name}`);
        const content = await result.outputs[0].text();
        const file = `${name}.mjs`;
        await writeFile(join(vendor, file), content);
        assets.push({ file, sha256: digest(content) });
    }

    const packages: {
        name: string; version: string; source: string; license: string;
        licenseSource: string; licenseFile: string; licenseSha256: string;
    }[] = [];
    async function recordPackages(directory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const path = join(directory, entry.name);
            if (entry.name.startsWith("@")) {
                await recordPackages(path);
                continue;
            }
            const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
            const licenseName = (await readdir(path)).find(name => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(name));
            if (!licenseName || typeof pkg.license !== "string") {
                throw new Error(`Missing licence for ${pkg.name}; do not publish the bundle.`);
            }
            const licenseFile = `${pkg.name.replaceAll("/", "__").replace("@", "")}.txt`;
            await copyFile(join(path, licenseName), join(licenses, licenseFile));
            const tarball = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").at(-1)}-${pkg.version}.tgz`;
            packages.push({
                name: pkg.name,
                version: pkg.version,
                source: tarball,
                license: pkg.license,
                licenseSource: `${tarball}#package/${licenseName}`,
                licenseFile: `../third-party-licenses/${licenseFile}`,
                licenseSha256: digest(await readFile(join(licenses, licenseFile))),
            });
        }
    }
    await recordPackages(join(client, "node_modules"));
    packages.sort((a, b) => a.name.localeCompare(b.name, "en"));
    await writeFile(join(vendor, "manifest.json"), JSON.stringify({
        sourceHash: await sourceHash(),
        bunVersion: Bun.version,
        assets,
        packages,
    }, null, 2) + "\n");
}

if (import.meta.main) await build();
