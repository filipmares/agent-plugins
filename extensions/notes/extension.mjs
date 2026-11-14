import { CanvasError, joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { NotesError } from "./errors.mjs";
import { createNotesTool } from "./notes-tool.mjs";
import { createPanelRegistry } from "./panels.mjs";
import { readSessionContext, resolveNotesDirectory } from "./platform.mjs";
import { createNotesServer, resolveTarget, waitForLibrary } from "./server.mjs";
import { NotesLibrary } from "./storage.mjs";
import { FailureJournal, failureJournalPath } from "./failure-journal.mjs";
import { uiStatePath } from "./ui-state.mjs";

let session;
let library;
let activeLibrary;
async function getLibrary() {
    if (!library) {
        library = resolveNotesDirectory().then(async directory => {
            const notes = new NotesLibrary(directory);
            await notes.startWatching(notifyPanels, {
                log,
                onFailure: error => diagnostics.recordFailure({
                    eventName: "notes.watcher.degraded",
                    errorCode: error?.code,
                    severityText: "WARN",
                    attributes: { component: "watcher" },
                    stack: error?.stack,
                }),
            });
            activeLibrary = notes;
            return notes;
        });
        library.catch(() => { library = undefined; });
    }
    return library;
}

const panels = createPanelRegistry();
const notifyPanels = () => panels.notify();
const log = (message, options) => session?.log(`[notes] ${message}`, options);
const diagnostics = new FailureJournal({ path: failureJournalPath(), log });
await diagnostics.recoverAbandonedPanelStarts();

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

// Note and folder targets wait a bounded time for the first scan; other opens return the panel immediately.
const libraryForTarget = () => waitForLibrary(getLibrary);

async function openPanel(ctx) {
    // Start the first scan alongside the panel; the client shows loading until it finishes.
    getLibrary().catch(() => { /* the panel's reads report it, and the next call retries */ });
    try {
        const panel = await panels.open(
            ctx.instanceId,
            () => resolveTarget(libraryForTarget, ctx.input ?? {}),
            async target => {
                const finishStartup = await diagnostics.beginPanelStartup();
                try {
                    return await createNotesServer({
                        getLibrary,
                        getContext: () => readSessionContext(ctx.sessionId, { allowMissing: true }),
                        sessionId: ctx.sessionId,
                        statePath: uiStatePath(),
                        target,
                        diagnostics,
                        onStartup: finishStartup,
                        onStartupStalled: finishStartup,
                        onPanelClose: finishStartup,
                        sendMessage: (options, sessionId) => {
                            if (sessionId !== session.sessionId) throw new NotesError("chat_unavailable", "The owning session changed. Reopen this Notes panel.");
                            return session.send(options);
                        },
                        log,
                    });
                } catch (error) {
                    await finishStartup?.();
                    throw error;
                }
            },
        );
        return { url: panel.url, title: "Notes" };
    } catch (error) {
        await diagnostics.recordFailure({
            eventName: "notes.canvas.open_failure",
            errorCode: error?.code,
            attributes: { component: "canvas" },
            stack: error?.stack,
        });
        throw canvasError(error);
    }
}

session = await joinSession({
    tools: [createNotesTool({
        getLibrary,
        getContext: readSessionContext,
        confirmPermanent: message => session.ui.confirm(message),
        log,
        diagnostics,
    })],
    canvases: [
        createCanvas({
            id: "notes",
            displayName: "Notes",
            description: "Apple Notes-style Markdown notes stored in Documents/Copilot Notes, with session provenance when opened from a session.",
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
                            const target = await resolveTarget(libraryForTarget, ctx.input ?? {});
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
}).catch(async error => {
    await diagnostics.recordFailure({
        eventName: "notes.provider.failure",
        errorCode: error?.code,
        attributes: { component: "provider" },
        stack: error?.stack,
    });
    throw error;
});

process.once("exit", () => activeLibrary?.close());
session.on("session.shutdown", () => {
    void library?.then(notes => notes.close()).catch(error => diagnostics.recordFailure({
        eventName: "notes.session.shutdown_failure",
        errorCode: error?.code,
        attributes: { component: "provider" },
        stack: error?.stack,
    }));
});
