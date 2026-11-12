import { NotesError } from "./errors.mjs";

// instanceId → Promise of the panel server; set synchronously so overlapping opens and closes cannot leak servers.
export function createPanelRegistry() {
    const panels = new Map();
    // Closes per instance: an opening overtaken by a close gives up rather than starting a server nobody will close.
    const closes = new Map();
    const closeCount = instanceId => closes.get(instanceId) ?? 0;

    return {
        async open(instanceId, getTarget, start) {
            const generation = closeCount(instanceId);
            const closedWhileOpening = () => closeCount(instanceId) !== generation;
            const target = await getTarget();
            for (;;) {
                if (closedWhileOpening()) throw new NotesError("panel_closed", "This Notes panel was closed while it was opening.");
                // Check and claim the slot with no await in between, so concurrent opens share one server.
                const entry = panels.get(instanceId);
                if (entry) {
                    const panel = await entry.catch(() => undefined);
                    if (panels.get(instanceId) !== entry) continue;
                    if (!panel || panel.closed) {
                        panels.delete(instanceId);
                        continue;
                    }
                    if (Object.keys(target).length) panel.reveal(target);
                    return panel;
                }
                const creation = start(target);
                panels.set(instanceId, creation);
                creation.catch(() => { if (panels.get(instanceId) === creation) panels.delete(instanceId); });
                const panel = await creation;
                if (closedWhileOpening()) throw new NotesError("panel_closed", "This Notes panel was closed while it was opening.");
                return panel;
            }
        },

        async find(instanceId) {
            const panel = await panels.get(instanceId)?.catch(() => undefined);
            return panel && !panel.closed ? panel : undefined;
        },

        async close(instanceId) {
            closes.set(instanceId, closeCount(instanceId) + 1);
            const entry = panels.get(instanceId);
            panels.delete(instanceId);
            const panel = await entry?.catch(() => undefined);
            await panel?.close();
        },

        notify() {
            for (const entry of panels.values()) entry.then(panel => panel.notifyChange(), () => {});
        },
    };
}
