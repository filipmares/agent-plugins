import { CanvasError, joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { createNotesTool } from "./notes-tool.mjs";
import { readSessionContext, resolveNotesDirectory } from "./platform.mjs";
import { NotesLibrary } from "./storage.mjs";

let session;
let library;
async function getLibrary() {
    if (!library) {
        library = resolveNotesDirectory().then(directory => new NotesLibrary(directory));
        library.catch(() => { library = undefined; });
    }
    return library;
}

const targetSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        noteId: { type: "string", minLength: 1 },
        folder: { type: "string" },
        view: { type: "string", enum: ["all", "project", "session"] },
    },
};

function editorPending() {
    throw new CanvasError("notes_editor_pending", "Phase 1 provides notes_manage. The Notes editor arrives in Phase 2.");
}

session = await joinSession({
    tools: [createNotesTool({
        getLibrary,
        getContext: readSessionContext,
        confirmPermanent: message => session.ui.confirm(message),
        log: (message, options) => session.log(`[notes] ${message}`, options),
    })],
    canvases: [
        createCanvas({
            id: "notes",
            displayName: "Notes",
            description: "Markdown notes with session provenance. Storage and the notes_manage tool are available; the editor is under construction.",
            inputSchema: targetSchema,
            actions: [
                {
                    name: "reveal",
                    description: "Reveal a note or folder once the Notes editor is available.",
                    inputSchema: targetSchema,
                    handler: editorPending,
                },
            ],
            open: editorPending,
        }),
    ],
});
