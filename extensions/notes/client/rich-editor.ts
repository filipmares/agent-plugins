// Adapted from bholmesdev/hubble.md packages/ui/src/editor/EditorView.tsx and packages/editor/src/List.ts @ cf633b3221b9572f22604168ac77c1ffa921debe, MIT.
import { Editor, Extension, InputRule, Node, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ListItem } from "@tiptap/extension-list";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { Selection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { markdownToDoc, roundTripSafe, serializeEdit } from "./rich-codec";

export const safeExternal = (value: string) => {
    try {
        return !/[\u0000-\u0020\u007f]/.test(value) && ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
    } catch { return false; }
};
const localImage = (value: string) => value !== "" && !/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(value);

// Typing ")" that completes [label](https://…) turns the label into a link; unsafe or code contexts stay literal.
// Returns the typed ")" and the conversion as separate steps so undo restores the literal syntax.
export function typedLink(state: EditorState, from: number, to: number, text: string): [Transaction, Transaction] | null {
    const $from = state.doc.resolve(from);
    const { code, link } = state.schema.marks;
    if (text !== ")" || from !== to || $from.parent.type.spec.code || (state.storedMarks ?? $from.marks()).some(mark => mark.type === code)) return null;
    const match = /\[([^[\]\ufffc]+)\]\(([^()\s\ufffc]+)$/.exec($from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc"));
    if (!match || !safeExternal(match[2])) return null;
    const start = $from.start() + match.index;
    if (state.doc.rangeHasMark(start, from, code)) return null;
    const insert = state.tr.insertText(text, from, to);
    const labelEnd = start + 1 + match[1].length;
    const convert = state.apply(insert).tr.delete(labelEnd, from + text.length).delete(start, start + 1)
        .addMark(start, labelEnd - 1, link.create({ href: match[2] })).removeStoredMark(link);
    return [insert, closeHistory(convert)];
}

// Enter after a top-level "| A | B |" line turns it into a header row plus one empty body row.
export function typedTable(state: EditorState): Transaction | null {
    const { $from, empty } = state.selection;
    if (!empty || $from.depth !== 1 || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return null;
    let plain = true;
    $from.parent.forEach(node => { if (!node.isText || node.marks.length) plain = false; });
    const row = plain && /^\s*\|(.*)\|\s*$/.exec($from.parent.textContent);
    const cells = row ? row[1].split("|").map(cell => cell.trim()) : [];
    if (!cells.some(Boolean)) return null;
    const { table, tableRow, tableHeader, tableCell, paragraph } = state.schema.nodes;
    const para = (value = "") => paragraph.create(null, value ? state.schema.text(value) : null);
    const header = tableRow.create(null, cells.map(cell => tableHeader.create(null, para(cell))));
    const body = tableRow.create(null, cells.map(() => tableCell.create(null, para())));
    const at = $from.before();
    const tr = state.tr.replaceWith(at, $from.after(), table.create(null, [header, body]));
    return closeHistory(tr.setSelection(Selection.near(tr.doc.resolve(at + 1 + header.nodeSize))));
}

const ChecklistItem = ListItem.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            checked: { default: null, parseHTML: el => el.hasAttribute("data-checked") ? el.getAttribute("data-checked") === "true" : null,
                renderHTML: attrs => attrs.checked === null ? {} : { "data-checked": String(attrs.checked) } },
            spread: { default: false, rendered: false },
        };
    },
    addInputRules() {
        return [new InputRule({
            find: /^\[([ xX])\]\s$/,
            handler: ({ state, range, match }) => {
                const { $from } = state.selection;
                if ($from.depth < 2 || $from.node(-1).type.name !== "listItem") return null;
                state.tr.delete(range.from, range.to).setNodeMarkup($from.before($from.depth - 1), undefined, {
                    ...$from.node(-1).attrs, checked: match[1].toLowerCase() === "x",
                });
            },
        })];
    },
    addKeyboardShortcuts() {
        return {
            ...this.parent?.(),
            Enter: () => {
                const { $from } = this.editor.state.selection;
                for (let depth = $from.depth; depth > 0; depth--) {
                    if ($from.node(depth).type.name === "listItem" && $from.node(depth).attrs.checked !== null) {
                        return this.editor.commands.splitListItem("listItem", { checked: false });
                    }
                }
                return this.editor.commands.splitListItem("listItem");
            },
        };
    },
    addNodeView() {
        return ({ node, getPos, editor }) => {
            const dom = document.createElement("li");
            const label = document.createElement("label");
            label.contentEditable = "false";
            label.className = "task-check";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            const contentDOM = document.createElement("div");
            label.append(checkbox);
            dom.append(label, contentDOM);
            const update = (current: typeof node) => {
                if (current.type !== node.type) return false;
                label.hidden = current.attrs.checked === null;
                if (label.hidden) delete dom.dataset.checked;
                else dom.dataset.checked = String(current.attrs.checked);
                checkbox.checked = current.attrs.checked === true;
                checkbox.setAttribute("aria-label", `Task: ${current.textContent || "empty item"}`);
                return true;
            };
            update(node);
            checkbox.addEventListener("change", () => {
                const pos = getPos();
                if (!editor.isEditable || pos === undefined) return;
                const current = editor.state.doc.nodeAt(pos);
                editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current?.attrs, checked: checkbox.checked }));
            });
            return { dom, contentDOM, update };
        };
    },
});

const MarkdownAttributes = Extension.create({
    name: "markdownAttributes",
    addGlobalAttributes() {
        return [
            { types: ["bulletList", "orderedList"], attributes: { spread: { default: false, rendered: false } } },
            { types: ["codeBlock"], attributes: { meta: { default: null, rendered: false } } },
            { types: ["link"], attributes: { title: { default: null } } },
            { types: ["tableCell", "tableHeader"], attributes: { align: {
                default: null,
                parseHTML: element => ["left", "center", "right"].includes(element.getAttribute("align") ?? "") ? element.getAttribute("align") : null,
                renderHTML: attributes => attributes.align ? { align: attributes.align } : {},
            } } },
        ];
    },
});

function imageExtension(noteKey: () => string | null, open: (url: string) => void) {
    return Node.create({
        name: "image", group: "inline", inline: true, atom: true, selectable: false, draggable: false,
        addAttributes: () => ({ src: { default: "" }, alt: { default: "" }, title: { default: null } }),
        // Clipboard HTML is never trusted to load resources.
        parseHTML: () => [],
        renderHTML: ({ node }) => ["span", { class: "note-image" }, node.attrs.alt || "Image"],
        addNodeView() {
            return ({ node }) => {
                const dom = document.createElement("span");
                dom.className = "note-image";
                dom.contentEditable = "false";
                const { src, alt, title } = node.attrs;
                if (localImage(src) && noteKey()) {
                    const img = document.createElement("img");
                    img.alt = alt || "Local image";
                    img.title = title ?? "";
                    img.src = `api/image?noteId=${encodeURIComponent(noteKey()!)}&src=${encodeURIComponent(src)}`;
                    img.addEventListener("error", () => { dom.textContent = `${alt || "Image"} (unavailable)`; });
                    dom.append(img);
                } else if (safeExternal(src)) {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "image-link";
                    button.textContent = alt || "Remote image";
                    button.title = `${src} (not loaded)`;
                    button.addEventListener("click", () => open(src));
                    dom.append(button);
                } else {
                    dom.textContent = `${alt || "Image"} (not loaded)`;
                }
                return { dom };
            };
        },
    });
}

export function editorExtensions(noteKey: () => string | null = () => null, open: (url: string) => void = () => {}) {
    return [
        StarterKit.configure({
            listItem: false, underline: false, trailingNode: false,
            link: { openOnClick: false, autolink: false, linkOnPaste: false, isAllowedUri: safeExternal,
                HTMLAttributes: { rel: "noreferrer noopener", target: null, draggable: "false" } },
        }),
        ChecklistItem, MarkdownAttributes, imageExtension(noteKey, open),
        Table.configure({ resizable: false }), TableRow,
        TableCell.extend({ content: "paragraph" }), TableHeader.extend({ content: "paragraph" }),
    ];
}

export function createRichEditor(options: {
    element: HTMLElement; body: string; noteKey: () => string | null;
    change: (body: string) => void; blur: () => void; error: (message: string) => void; notice: (message: string) => void;
    link: () => void; open: (url: string) => void;
}) {
    let baseline: JSONContent;
    const tableBreak = () => {
        if (!editor.isActive("table")) return false;
        options.notice("Markdown table cells cannot contain line breaks.");
        return true;
    };
    function editLinkAt(link: HTMLElement) {
        editor.commands.setTextSelection({
            from: editor.view.posAtDOM(link, 0),
            to: editor.view.posAtDOM(link, link.childNodes.length),
        });
        options.link();
    }
    const shortcuts = Extension.create({
        name: "noteShortcuts",
        addKeyboardShortcuts() {
            return {
                "Mod-k": () => { options.link(); return true; },
                Enter: () => {
                    if (this.editor.isActive("table")) return this.editor.commands.goToNextCell();
                    const tr = typedTable(this.editor.state);
                    if (tr) this.editor.view.dispatch(tr);
                    return !!tr;
                },
                "Shift-Enter": tableBreak,
                "Mod-Enter": tableBreak,
            };
        },
    });
    const editor = new Editor({
        element: options.element,
        injectCSS: false,
        extensions: [...editorExtensions(options.noteKey, options.open), shortcuts],
        content: markdownToDoc(options.body),
        editorProps: {
            attributes: { role: "textbox", "aria-label": "Note", "aria-multiline": "true", spellcheck: "true" },
            handleTextInput: (view, from, to, text) => {
                const steps = view.composing ? null : typedLink(view.state, from, to, text);
                if (!steps) return false;
                view.dispatch(steps[0]);
                if (view.state.doc.eq(steps[1].before)) view.dispatch(steps[1]);
                return true;
            },
            handleDOMEvents: {
                auxclick: (_view, event) => {
                    if (!(event.target as HTMLElement).closest("a")) return false;
                    event.preventDefault();
                    return true;
                },
                contextmenu: (_view, event) => {
                    const link = (event.target as HTMLElement).closest("a");
                    if (!link) return false;
                    event.preventDefault();
                    editLinkAt(link);
                    return true;
                },
            },
            handleClick: (_view, _pos, event) => {
                const link = (event.target as HTMLElement).closest("a");
                if (!link) return false;
                event.preventDefault();
                editLinkAt(link);
                return true;
            },
            handlePaste: (view, event) => {
                const plain = event.clipboardData?.getData("text/plain");
                if (!plain) return true;
                if (editor.isActive("table") && /[\r\n]/.test(plain)) {
                    options.notice("Markdown table cells cannot contain line breaks. Paste one line at a time.");
                    return true;
                }
                // Plain text only: never instantiate clipboard HTML, images, styles or remote resources.
                view.dispatch(view.state.tr.insertText(plain));
                return true;
            },
            handleDrop: (_view, event) => { if (event.dataTransfer?.files.length) { options.notice("Image pasting is not supported. Add images in Markdown view."); return true; } return false; },
        },
        onUpdate: ({ editor }) => {
            try { options.change(serializeEdit(editor.getJSON(), options.body, baseline)); }
            catch (error) { options.error(error instanceof Error ? error.message : String(error)); }
        },
        onBlur: options.blur,
    });
    baseline = editor.getJSON();
    return { editor, safe: roundTripSafe(options.body, baseline) };
}
