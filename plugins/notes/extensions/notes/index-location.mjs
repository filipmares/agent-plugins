import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NotesError } from "./errors.mjs";
import { retryTransient } from "./filesystem.mjs";
import { shadowIndexFile } from "./shadow-index.mjs";

export async function activeIndexFile(root, directory) {
    const base = shadowIndexFile(root);
    let generation;
    try { generation = await readFile(join(directory, `${base}.active`), "utf8"); }
    catch (error) {
        if (error.code === "ENOENT") return base;
        throw error;
    }
    if (!/^[a-f0-9-]{36}$/.test(generation)) throw new NotesError("index_unavailable", "The index generation is invalid. Rebuild the index.");
    return `${base}.${generation}.sqlite`;
}

export async function rotateIndex(root, directory) {
    const pointer = join(directory, `${shadowIndexFile(root)}.active`);
    const generation = randomUUID();
    const temporary = `${pointer}.${generation}.tmp`;
    try {
        await writeFile(temporary, generation, { flag: "wx", mode: 0o600 });
        // Last publication wins. Existing connections keep their old cache; none is unlinked.
        await retryTransient(() => rename(temporary, pointer));
    } finally {
        try { await retryTransient(() => unlink(temporary)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}
