export class NotesError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = "NotesError";
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

export function requireString(value, name, { empty = false } = {}) {
    if (typeof value !== "string" || (!empty && value.trim() === "")) {
        throw new NotesError("invalid_request", `${name} must be ${empty ? "a" : "a non-empty"} string.`);
    }
    return value;
}
