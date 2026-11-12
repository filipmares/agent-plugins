import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseDocument } from "./vendor/yaml.mjs";
import { NotesError } from "./errors.mjs";

const execute = promisify(execFile);
const windowsShell = () => win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const commandOptions = { windowsHide: true, timeout: 30000, maxBuffer: 256 * 1024 };

export function copilotHome(env = process.env, home = homedir()) {
    return resolve(env.COPILOT_HOME || join(home, ".copilot"));
}

export async function resolveNotesDirectory({ platform = process.platform, home = homedir(), run = execute } = {}) {
    const paths = platform === "win32" ? win32 : posix;
    let documents;
    try {
        if (platform === "win32") {
            const { stdout } = await run(windowsShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments', 'DoNotVerify')"], commandOptions);
            documents = stdout.trim().replace(/^\ufeff/, "");
        } else if (platform === "darwin") {
            documents = paths.join(home, "Documents");
        } else if (platform === "linux") {
            const { stdout } = await run("xdg-user-dir", ["DOCUMENTS"], commandOptions);
            documents = stdout.trim();
        } else {
            throw new NotesError("platform_unsupported", "Notes supports Windows, macOS, and Linux.");
        }
    } catch (error) {
        if (error instanceof NotesError) throw error;
        throw new NotesError("documents_unavailable", "Could not resolve your Documents folder. On Linux, install xdg-user-dirs.");
    }
    if (!documents || !paths.isAbsolute(documents)) {
        throw new NotesError("documents_unavailable", "The operating system did not return an absolute Documents folder.");
    }
    return paths.join(documents, "Copilot Notes");
}

export async function readSessionContext(sessionId, { home = copilotHome() } = {}) {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
        throw new NotesError("invalid_session", "The calling session ID is invalid.");
    }
    const path = join(home, "session-state", sessionId, "workspace.yaml");
    let source;
    try {
        const stats = await lstat(path);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 256 * 1024) {
            throw new NotesError("session_metadata_unavailable", "The session metadata is not a small regular YAML file.");
        }
        source = await readFile(path, "utf8");
    } catch (error) {
        if (error instanceof NotesError) throw error;
        throw new NotesError("session_metadata_unavailable", "Cannot read this session's workspace.yaml; no provenance was guessed.");
    }
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) {
        throw new NotesError("session_metadata_unavailable", "The session's workspace.yaml is invalid.");
    }
    let data;
    try {
        data = document.toJS({ maxAliasCount: 50 });
    } catch {
        throw new NotesError("session_metadata_unavailable", "The session metadata could not be decoded safely.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || (data.id !== undefined && data.id !== sessionId)) {
        throw new NotesError("session_metadata_unavailable", "The workspace metadata does not describe this session.");
    }
    for (const key of ["name", "repository", "branch", "cwd"]) {
        if (data[key] !== undefined && typeof data[key] !== "string") {
            throw new NotesError("session_metadata_unavailable", `The session ${key} is not a string.`);
        }
    }
    return {
        sessionId,
        ...(data.name ? { sessionName: data.name } : {}),
        ...(data.repository || data.cwd ? { project: data.repository || data.cwd } : {}),
        ...(data.branch ? { branch: data.branch } : {}),
    };
}

export async function trashItem(path, { platform = process.platform, run = execute } = {}) {
    try {
        if (platform === "win32") {
            const script = join(dirname(fileURLToPath(import.meta.url)), "windows-trash.ps1");
            await run(windowsShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
                "-File", script, Buffer.from(path, "utf8").toString("base64")], commandOptions);
        } else if (platform === "darwin") {
            await run("/usr/bin/osascript", ["-e", "on run argv",
                "-e", "set targetItem to POSIX file (item 1 of argv) as alias",
                "-e", 'tell application "Finder" to delete targetItem',
                "-e", "end run", "--", path], commandOptions);
        } else if (platform === "linux") {
            await run("gio", ["trash", "--", path], commandOptions);
        } else {
            throw new NotesError("trash_unavailable", "No OS trash adapter is available on this platform.");
        }
    } catch (error) {
        if (error instanceof NotesError) throw error;
        const failure = new NotesError("trash_unavailable", "The operating system could not move the item to its trash.");
        failure.cause = error;
        throw failure;
    }
}
