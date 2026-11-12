import { CanvasError, joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { NotesError } from "./errors.mjs";
import { createNotesTool } from "./notes-tool.mjs";
import { readSessionContext, resolveNotesDirectory } from "./platform.mjs";
import { createNotesServer, resolveTarget } from "./server.mjs";
import { NotesLibrary } from "./storage.mjs";
import { uiStatePath } from "./ui-state.mjs";

let session;
let library;
async function getLibrary() {
    if (!library) {
        library = resolveNotesDirectory().then(directory => new NotesLibrary(directory));
        library.catch(() => { library = undefined; });
    }
    return library;
}

// instanceId → Promise of the panel server; set synchronously so overlapping opens and closes cannot leak servers.
const panels = new Map();
const notifyPanels = () => { for (const entry of panels.values()) entry.then(panel => panel.notifyChange(), () => {}); };
const log = (message, options) => session?.log(`[notes] ${message}`, options);

const targetSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        noteId: { type: "string", minLength: 1 },
        folder: { type: "string" },
        view: { type: "string", enum: ["all", "project", "session"] },
    },
};

function canvasError(error) {
    if (error instanceof CanvasError) return error;
    if (error instanceof NotesError) return new CanvasError(error.code, error.message);
    return new CanvasError("io_error", `Notes could not open (${error?.code ?? "unexpected error"}).`);
}

async function openPanel(ctx) {
    try {
        const target = await resolveTarget(await getLibrary(), ctx.input ?? {});
        for (;;) {
            // Check and claim the slot with no await in between, so concurrent opens share one server.
            const entry = panels.get(ctx.instanceId);
            if (entry) {
                const panel = await entry.catch(() => undefined);
                if (panels.get(ctx.instanceId) !== entry) continue;
                if (!panel || panel.closed) {
                    panels.delete(ctx.instanceId);
                    continue;
                }
                if (Object.keys(target).length) panel.reveal(target);
                return { url: panel.url, title: "Notes" };
            }
            const creation = createNotesServer({
                getLibrary,
                getContext: () => readSessionContext(ctx.sessionId),
                sessionId: ctx.sessionId,
                statePath: uiStatePath(),
                target,
                onChange: notifyPanels,
                log,
            });
            panels.set(ctx.instanceId, creation);
            creation.catch(() => { if (panels.get(ctx.instanceId) === creation) panels.delete(ctx.instanceId); });
            const panel = await creation;
            if (panels.get(ctx.instanceId) !== creation) continue;
            return { url: panel.url, title: "Notes" };
        }
    } catch (error) {
        throw canvasError(error);
    }
}

session = await joinSession({
    tools: [createNotesTool({
        getLibrary,
        getContext: readSessionContext,
        confirmPermanent: message => session.ui.confirm(message),
        log,
        onChange: notifyPanels,
    })],
    canvases: [
        createCanvas({
            id: "notes",
            displayName: "Notes",
            description: "Apple Notes-style Markdown notes stored in Documents/Copilot Notes, with session provenance.",
            inputSchema: targetSchema,
            actions: [
                {
                    name: "reveal",
                    description: "Show a note, folder, or smart view (all, project, session) in this Notes panel.",
                    inputSchema: targetSchema,
                    handler: async ctx => {
                        const panel = await panels.get(ctx.instanceId)?.catch(() => undefined);
                        if (!panel || panel.closed) throw new CanvasError("not_open", "This Notes panel is not open.");
                        try {
                            const target = await resolveTarget(await getLibrary(), ctx.input ?? {});
                            panel.reveal(target);
                            return { revealed: target };
                        } catch (error) {
                            throw canvasError(error);
                        }
                    },
                },
            ],
            open: openPanel,
            onClose: async ctx => {
                const entry = panels.get(ctx.instanceId);
                panels.delete(ctx.instanceId);
                const panel = await entry?.catch(() => undefined);
                await panel?.close();
            },
        }),
    ],
});
