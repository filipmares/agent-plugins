import { createHash, randomBytes } from "node:crypto";
import { Document, isMap, parseDocument, visit } from "./vendor/yaml.mjs";
import { parseMarkdown } from "./vendor/markdown.mjs";
import { NotesError, requireString } from "./errors.mjs";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;

export function contentHash(content) {
    return createHash("sha256").update(content).digest("hex");
}

export function newId(timestamp = Date.now(), entropy = randomBytes(10)) {
    let value = (BigInt(Math.max(0, Math.min(281474976710655, Math.floor(timestamp)))) << 80n)
        | BigInt(`0x${entropy.subarray(0, 10).toString("hex")}`);
    let id = "";
    for (let i = 0; i < 26; i++) {
        id = ALPHABET[Number(value & 31n)] + id;
        value >>= 5n;
    }
    return id;
}

export function adoptionId(path, birthtimeMs) {
    return newId(birthtimeMs, createHash("sha256").update(`${path}\0${birthtimeMs}`).digest());
}

export function localTimestamp(value = new Date()) {
    const date = new Date(value);
    const offset = -date.getTimezoneOffset();
    const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, -1);
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
    return `${local}${offset < 0 ? "-" : "+"}${hours}:${minutes}`;
}

function metadataWarning(data) {
    if (data.id !== undefined && (typeof data.id !== "string" || !ULID.test(data.id))) return "id must be a ULID.";
    for (const key of ["created", "updated"]) {
        if (data[key] !== undefined && (typeof data[key] !== "string" || !Number.isFinite(Date.parse(data[key])))) {
            return `${key} must be an ISO date string.`;
        }
    }
    if (data.sessions !== undefined && (!Array.isArray(data.sessions) || data.sessions.some(id => typeof id !== "string"))) {
        return "sessions must be a list of session IDs.";
    }
    for (const key of ["project", "branch", "session_id", "session_name"]) {
        if (data[key] !== undefined && typeof data[key] !== "string") return `${key} must be a string.`;
    }
    if (data.created_by !== undefined && !["user", "agent"].includes(data.created_by)) return "created_by must be user or agent.";
    if (data.pinned !== undefined && typeof data.pinned !== "boolean") return "pinned must be a boolean.";
    return undefined;
}

function requireJsonValue(value, ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
        if (Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
    } else if (typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if ((Array.isArray(value) || prototype === Object.prototype || prototype === null) && !ancestors.has(value)) {
            ancestors.add(value);
            for (const child of Object.values(value)) requireJsonValue(child, ancestors);
            ancestors.delete(value);
            return;
        }
    }
    throw new Error("Frontmatter contains values that cannot be represented losslessly in JSON.");
}

export function parseNote(raw) {
    const bom = raw.startsWith("\ufeff") ? "\ufeff" : "";
    const source = raw.slice(bom.length);
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const opening = /^---\r?\n/.exec(source);
    let document = new Document({});
    let body = source;
    let hasFrontmatter = false;
    let warning;
    if (opening) {
        hasFrontmatter = true;
        const closing = /^(?:---|\.\.\.)(?:\r?\n|$)/m.exec(source.slice(opening[0].length));
        if (!closing) {
            warning = "The frontmatter closing delimiter is missing.";
        } else {
            const end = opening[0].length + closing.index;
            document = parseDocument(source.slice(opening[0].length, end), { uniqueKeys: true });
            body = source.slice(end + closing[0].length);
            if (document.errors.length) warning = document.errors.map(error => error.message).join("; ");
            else if (document.warnings.length) warning = document.warnings.map(item => item.message).join("; ");
            else if (document.contents !== null && !isMap(document.contents)) warning = "Frontmatter must be a YAML mapping.";
        }
    }
    let metadata = {};
    if (!warning) {
        try {
            metadata = document.toJS({ maxAliasCount: 50 }) ?? {};
            requireJsonValue(metadata);
            warning = metadataWarning(metadata);
        } catch (error) {
            warning = `Cannot safely read frontmatter: ${error.message}`;
        }
    }
    return {
        raw, bom, eol, document, hasFrontmatter,
        body: warning ? raw : body,
        metadata: warning ? {} : metadata,
        warning: warning ? { code: "invalid_frontmatter", message: warning } : undefined,
    };
}

export function serializeNote(note, body, changes = {}) {
    if (note.warning) {
        throw new NotesError("invalid_frontmatter", "Repair the frontmatter in plain Markdown before changing metadata.");
    }
    const document = note.document.clone();
    for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) {
            const previous = document.get(key, true);
            if (previous?.anchor) {
                visit(document, { Alias(_key, alias) {
                    if (alias.resolve(document) !== previous) return;
                    const copy = previous.clone();
                    delete copy.anchor;
                    return copy;
                } });
            }
            document.delete(key);
        }
        else {
            const previous = document.get(key, true);
            const next = document.createNode(value);
            for (const property of ["anchor", "comment", "commentBefore", "spaceBefore"]) {
                if (previous?.[property] !== undefined) next[property] = previous[property];
            }
            if (key === "sessions" && previous?.items) {
                next.items = next.items.map(item => previous.items.find(old =>
                    (old.value ?? old.resolve?.(document)?.value) === item.value) ?? item);
            }
            document.set(key, next);
        }
    }
    const header = document.toString({ lineWidth: 0 }).replaceAll("\n", note.eol);
    return `${note.bom}---${note.eol}${header}---${note.eol}${body}`;
}

export function titleOf(body) {
    return body.split(/\r?\n/, 1)[0].replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").trim() || "Untitled";
}

export function newNoteBody(body) {
    requireString(body, "body");
    const text = body.replace(/^(?:[ \t]*\r?\n)+/, "");
    const first = text.split(/\r?\n/, 1)[0];
    return `# ${first.replace(/^#{1,6}\s+/, "").trim()}${text.slice(first.length)}`;
}

export function slug(title) {
    let value = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
    value = Array.from(value).slice(0, 40).join("").replace(/-+$/g, "") || "untitled";
    return RESERVED_NAME.test(value) ? `note-${value}`.slice(0, 40) : value;
}

export function folderName(name) {
    requireString(name, "Folder name");
    if (name === "." || name === ".." || name.includes("\0")) {
        throw new NotesError("invalid_path", "Relative path segments and NUL bytes are not allowed.");
    }
    const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/[. ]+$/g, "");
    if (!cleaned || cleaned.startsWith(".") || /\.assets$/i.test(cleaned) || RESERVED_NAME.test(cleaned)) {
        throw new NotesError("invalid_name", "Choose a non-hidden folder name that is not reserved by Windows or Notes.");
    }
    if (cleaned.length > 255) throw new NotesError("invalid_name", "A folder name must not exceed 255 characters.");
    return cleaned;
}

export function foldText(value) {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function markdownText(body) {
    const parts = [];
    function visit(node) {
        if (["text", "inlineCode", "code"].includes(node.type)) parts.push(node.value);
        else if (node.type === "image" || node.type === "imageReference") parts.push(node.alt ?? "");
        else if (node.children) node.children.forEach(visit);
    }
    visit(parseMarkdown(body));
    return parts.join(" ").replace(/\s+/g, " ").trim();
}

// Patch destination ranges, not rendered Markdown: code examples and formatting stay byte-for-byte intact.
export function renameAssetLinks(body, oldName, newName, { caseInsensitive = false } = {}) {
    if (oldName === newName) return body;
    const key = value => caseInsensitive ? value.toLowerCase() : value;
    const edits = [];
    function visit(node) {
        if (["link", "image", "definition"].includes(node.type)) {
            let url;
            try { url = decodeURI(node.url); } catch { url = node.url; }
            const prefix = key(url).startsWith(key(`./${oldName}/`)) ? "./" : "";
            if (key(url).startsWith(key(`${prefix}${oldName}/`))) {
                const source = body.slice(node.position.start.offset, node.position.end.offset);
                let end = node.type === "image" ? 1 : 0;
                let depth = 0;
                for (; end < source.length; end++) {
                    if (source[end] === "\\") { end++; continue; }
                    if (source[end] === "[") depth++;
                    if (source[end] === "]" && --depth === 0) break;
                }
                if (node.type === "link" && node.children.length) {
                    end = node.children.at(-1).position.end.offset - node.position.start.offset;
                }
                const delimiter = node.type === "definition" ? "]:" : "](";
                if (!source.startsWith(delimiter, end)) {
                    throw new NotesError("asset_link_unsupported", "Cannot safely rewrite an asset link; the note was not moved.");
                }
                const whitespace = /^[ \t\r\n]*<?/.exec(source.slice(end + 2))[0];
                const start = node.position.start.offset + end + 2 + whitespace.length;
                const variants = [oldName, encodeURI(oldName), oldName.replace(/[\\()[\] *]/g, "\\$&")];
                const matched = variants.find(name => key(body.slice(start, start + prefix.length + name.length + 1)) === key(`${prefix}${name}/`));
                if (!matched) throw new NotesError("asset_link_unsupported", "Cannot safely rewrite an encoded asset link.");
                const replacement = matched === encodeURI(oldName) && matched !== oldName ? encodeURI(newName)
                    : matched !== oldName ? newName.replace(/[\\()[\] *]/g, "\\$&") : newName;
                edits.push({ start: start + prefix.length, length: matched.length, replacement });
            }
        }
        node.children?.forEach(visit);
    }
    visit(parseMarkdown(body));
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        body = body.slice(0, edit.start) + edit.replacement + body.slice(edit.start + edit.length);
    }
    return body;
}
