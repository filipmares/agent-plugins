import { watch } from "node:fs";

// Each provider watches one library, even when it has several panels or only the tool.
export function watchLibrary(directory, rescan, { log = () => {}, onFailure, watchFs = watch, intervalMs = 30000, debounceMs = 150 } = {}) {
    let closed = false, running = false, pending = false, timer, watcher;
    const report = error => {
        onFailure?.(error);
        log(`Notes live sync: ${error.message}. The periodic rescan remains enabled.`, { level: "warning" });
    };
    async function refresh() {
        if (closed) return;
        if (running) { pending = true; return; }
        running = true;
        try { await rescan(); } catch (error) { report(error); }
        finally {
            running = false;
            if (pending && !closed) { pending = false; schedule(); }
        }
    }
    function schedule(_event, filename) {
        if (filename && String(filename).split(/[\\/]/).some(part => part.startsWith("."))) return;
        clearTimeout(timer);
        timer = setTimeout(refresh, debounceMs);
        timer.unref?.();
    }
    try {
        watcher = watchFs(directory, { recursive: true }, schedule);
        watcher.on("error", error => { watcher.close(); report(error); });
        watcher.unref?.();
    } catch (error) { report(error); }
    const interval = setInterval(refresh, intervalMs);
    interval.unref?.();
    return () => { closed = true; pending = false; clearTimeout(timer); clearInterval(interval); watcher?.close(); };
}
