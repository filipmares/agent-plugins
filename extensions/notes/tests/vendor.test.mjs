import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sourceHash } from "../client/build.ts";

const digest = value => createHash("sha256").update(value).digest("hex");

test("committed bundles and licences match the pinned build sources", async () => {
    const directory = new URL("../vendor/", import.meta.url);
    const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
    expect(await sourceHash()).toBe(manifest.sourceHash);
    for (const asset of manifest.assets) {
        expect(digest(await readFile(new URL(asset.file, directory)))).toBe(asset.sha256);
    }
    for (const pkg of [...manifest.packages, ...manifest.adaptedSources ?? []]) {
        expect(digest(await readFile(new URL(pkg.licenseFile, directory)))).toBe(pkg.licenseSha256);
    }
});
