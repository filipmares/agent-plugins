import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = "benchmark-results";
const sizes = [1000, 10000];

if (process.argv[2] === "--check") {
    const result = JSON.parse(await readFile(join(process.argv[3], "exits.json"), "utf8")) as Record<string, number>;
    const statuses = JSON.parse(await readFile(join(process.argv[3], "status.json"), "utf8")) as { notes: number; status: string }[];
    if (sizes.some(size => result[size] !== 0 || !statuses.some(item => item.notes === size && item.status === "complete"))) {
        throw new Error("One or more Notes benchmarks failed; see artifacts and dashboard.");
    }
} else {
    await mkdir(directory, { recursive: true });
    const exits: Record<number, number> = {};
    for (const size of sizes) {
        console.log(`Running ${size} notes...`);
        const stdout = Bun.file(join(directory, `${size}.json`)).writer();
        const stderr = Bun.file(join(directory, `${size}.log`)).writer();
        const child = Bun.spawn([process.execPath, "run", "scripts/bench-notes-startup.ts", "--notes", String(size), "--samples", "7", "--json"], {
            stdout: "pipe", stderr: "pipe",
        });
        const copy = async (stream: ReadableStream<Uint8Array>, writer: typeof stdout) => {
            for await (const chunk of stream) writer.write(chunk);
            await writer.end();
        };
        await Promise.all([copy(child.stdout, stdout), copy(child.stderr, stderr)]);
        exits[size] = await child.exited;
        console.log(`${size} notes: exit ${exits[size]}`);
        await writeFile(join(directory, "exits.json"), JSON.stringify(exits, null, 2));
    }
}
