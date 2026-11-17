// Dependency-free helpers shared by the app shell and the lazily loaded rich editor.
export const GUARD_MESSAGE = "This note uses Markdown the rich editor can't keep exactly.";

export const safeExternal = (value: string) => {
    try {
        return !/[\u0000-\u0020\u007f]/.test(value) && ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
    } catch { return false; }
};
