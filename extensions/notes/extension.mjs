import { CanvasError, joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { NotesError } from "./errors.mjs";
import { createNotesTool } from "./notes-tool.mjs";
import { createPanelRegistry } from "./panels.mjs";
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

const panels = createPanelRegistry();
const notifyPanels = () => panels.notify();
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
        const panel = await panels.open(
            ctx.instanceId,
            async () => resolveTarget(await getLibrary(), ctx.input ?? {}),
            target => createNotesServer({
                getLibrary,
                getContext: () => readSessionContext(ctx.sessionId),
                sessionId: ctx.sessionId,
                statePath: uiStatePath(),
                target,
                onChange: notifyPanels,
                log,
            }),
        );
        return { url: panel.url, title: "Notes" };
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
                        const panel = await panels.find(ctx.instanceId);
                        if (!panel) throw new CanvasError("not_open", "This Notes panel is not open.");
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
            onClose: ctx => panels.close(ctx.instanceId),
        }),
    ],
});
