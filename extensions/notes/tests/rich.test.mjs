import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { markdownToDoc, docToMarkdown, roundTripSafe, sameMeaning, serializeEdit } from "../client/rich-codec.ts";
import { editorExtensions, safeExternal, typedLink, typedTable } from "../client/rich-editor.ts";
import { parseMarkdown } from "../client/markdown.ts";

const require = createRequire(new URL("../client/package.json", import.meta.url));
const { getSchema } = require("@tiptap/core");
const { EditorState, Selection } = require("@tiptap/pm/state");
const { history, undo } = require("@tiptap/pm/history");
const schema = getSchema(editorExtensions());
const roundtrip = source => schema.nodeFromJSON(markdownToDoc(source)).toJSON();
const typedState = (doc, end = true) => {
    const node = schema.nodeFromJSON(doc);
    return EditorState.create({ doc: node, selection: end ? Selection.atEnd(node) : Selection.atStart(node) });
};
const para = (...content) => ({ type: "doc", content: [{ type: "paragraph", content }] });

describe("rich Markdown boundary", () => {
    test.each([
        "",
        "# Title\n\nA plain paragraph.\n",
        "Existing title without a heading\n\nSecond paragraph",
        "Setext title\n===========\n\nBody",
        "# **Bold** and *italic* with ~~strike~~ and `inline code`\n",
        "A **bold *and italic* run** with [a **bold** link](https://example.com/a%28b \"title\").\n",
        "> Quote\n>\n> - One\n> - Two\n",
        "- one\n- [ ] two\n- [x] three\n",
        "3. three\n   - nested\n4. four\n",
        "- first\n\n  second paragraph\n\n- next\n",
        "```ts title\nconst x = `tick`;\n```\n\n---\n",
        "````\n```\ninside fence\n```\n````\n",
        "A `` `code` `` span and literal \\* text &amp; entities.\n",
        "Hard  \nbreak and soft\nbreak.\n",
        "| Left | Center | Right |\n| :--- | :---: | ---: |\n| **A** | `b\\|c` | d |\n",
        "Inline ![A [square]](plan.assets/a%28b.png \"image title\") next to text.\n",
        "![Private remote](https://example.com/tracking.png)\n",
        "[unsafe](javascript:alert%281%29) and [local](../other.md)\n",
        "Unicode café 日本語 😀\n",
    ])("accepts supported semantic round trip: %s", source => {
        const doc = roundtrip(source);
        expect(roundTripSafe(source, doc)).toBe(true);
        expect(sameMeaning(source, docToMarkdown(doc))).toBe(true);
        expect(serializeEdit(doc, source, doc)).toBe(source);
    });

    test.each([
        "<div onclick='bad()'>HTML</div>\n",
        "Text with <em>HTML</em>.",
        "Footnote[^one]\n\n[^one]: Keep me\n",
        "[ref][id]\n\n[id]: https://example.com \"Reference title\"\n",
        "![ref][id]\n\n[id]: image.png",
        "$$x^2$$",
        "Inline $x^2$",
        "```mermaid\ngraph TD\nA-->B\n```",
        "[[Wiki link]]",
    ])("falls back rather than silently losing unsupported syntax: %s", source => {
        const doc = roundtrip(source);
        expect(roundTripSafe(source, doc)).toBe(false);
    });

    test("an edit preserves an unchanged first line and escapes new Markdown metacharacters", () => {
        const source = "Unmarked *title*\n\nSecond paragraph\n";
        const baseline = roundtrip(source);
        const edited = structuredClone(baseline);
        edited.content[1].content = [{ type: "text", text: "*not emphasis* [literal] & <script>" }];
        const saved = serializeEdit(edited, source, baseline);
        expect(saved.split("\n")[0]).toBe(source.split("\n")[0]);
        expect(sameMeaning(saved, docToMarkdown(edited))).toBe(true);
    });

    test("boundary spaces don't destroy formatting or merge words", () => {
        const doc = { type: "doc", content: [{ type: "paragraph", content: [
            { type: "text", text: " bold ", marks: [{ type: "bold" }] },
            { type: "text", text: "next" },
        ] }] };
        expect(parseMarkdown(docToMarkdown(doc)).children[0].children).toMatchObject([
            { type: "text", value: " " }, { type: "strong", children: [{ type: "text", value: "bold" }] },
            { type: "text", value: " next" },
        ]);
    });

    test("structural edits do not merge neighboring lists when retaining their source", () => {
        const source = "Title\n\n* one\n\nBetween\n\n* two\n";
        const baseline = roundtrip(source);
        const edited = structuredClone(baseline);
        edited.content.splice(2, 1);
        const saved = serializeEdit(edited, source, baseline);
        expect(sameMeaning(saved, docToMarkdown(edited))).toBe(true);
        expect(parseMarkdown(saved).children.filter(node => node.type === "list")).toHaveLength(2);
    });

    test("code formatting across an image or hard break never drops the inline content", () => {
        const doc = { type: "doc", content: [{ type: "paragraph", content: [
            { type: "text", text: "before", marks: [{ type: "code" }] },
            { type: "image", attrs: { src: "local.png", alt: "kept" }, marks: [{ type: "code" }] },
            { type: "hardBreak", marks: [{ type: "code" }] },
            { type: "text", text: "after", marks: [{ type: "code" }] },
        ] }] };
        expect(parseMarkdown(docToMarkdown(doc)).children[0].children).toMatchObject([
            { type: "inlineCode", value: "before" }, { type: "image", url: "local.png", alt: "kept" },
            { type: "break" }, { type: "inlineCode", value: "after" },
        ]);
    });

    test.each([
        { content: [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }] },
        { content: [{ type: "text", text: "one\ntwo" }] },
    ])("refuses table line breaks instead of saving flattened cell text", ({ content }) => {
        const doc = roundtrip("| Header |\n| --- |\n| Original |");
        doc.content[0].content[1].content[0].content[0].content = content;
        expect(() => docToMarkdown(doc)).toThrow("cannot contain line breaks");
    });

    test.each(["javascript:alert(1)", "data:image/svg+xml,bad", "file:///C:/x", "//example.com", "https://a\nb", "vscode://x"])("refuses unsafe link %s", url => {
        expect(safeExternal(url)).toBe(false);
    });

    test("typing ) after [label](url) makes a link and keeps the label's formatting", () => {
        const state = typedState(para({ type: "text", text: "See [" }, { type: "text", text: "docs", marks: [{ type: "bold" }] },
            { type: "text", text: "](https://example.com/a" }));
        const pos = state.selection.from;
        const [insert, convert] = typedLink(state, pos, pos, ")");
        const tr = convert;
        expect(insert.doc.textContent).toBe("See [docs](https://example.com/a)");
        expect(parseMarkdown(docToMarkdown(tr.doc.toJSON())).children[0].children).toMatchObject([
            { type: "text", value: "See " },
            { type: "link", url: "https://example.com/a", children: [{ type: "strong", children: [{ type: "text", value: "docs" }] }] },
        ]);
        expect(tr.storedMarks?.some(mark => mark.type.name === "link") ?? false).toBe(false);
    });

    test.each([
        ["unsafe scheme", para({ type: "text", text: "[x](javascript:alert" }), ")"],
        ["relative URL", para({ type: "text", text: "[x](../other.md" }), ")"],
        ["other character", para({ type: "text", text: "[x](https://example.com" }), "x"],
        ["inline code", para({ type: "text", text: "[x](https://example.com", marks: [{ type: "code" }] }), ")"],
        ["code block", { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "[x](https://example.com" }] }] }, ")"],
    ])("typed link syntax stays literal for %s", (_name, doc, text) => {
        const state = typedState(doc);
        expect(typedLink(state, state.selection.from, state.selection.from, text)).toBeNull();
    });

    test("Enter after a typed | A | B | row makes a table and moves into the first body cell", () => {
        const source = "Intro\n\n| A | B |\n";
        const baseline = roundtrip(source);
        const tr = typedTable(typedState(baseline));
        const table = parseMarkdown(serializeEdit(tr.doc.toJSON(), source, baseline)).children[1];
        expect(table).toMatchObject({ type: "table", children: [
            { children: [{ children: [{ value: "A" }] }, { children: [{ value: "B" }] }] },
            { children: [{ children: [] }, { children: [] }] },
        ] });
        expect(tr.selection.$from.node(-1).type.name).toBe("tableCell");
        expect(tr.selection.$from.index(1)).toBe(1);
    });

    test.each([
        ["not a row", para({ type: "text", text: "Not | a | row" })],
        ["no cell text", para({ type: "text", text: "| |" })],
        ["formatted text", para({ type: "text", text: "| A |", marks: [{ type: "bold" }] })],
        ["nested in a list", roundtrip("- \\| A \\|\n")],
    ])("Enter leaves %s alone", (_name, doc) => {
        expect(typedTable(typedState(doc))).toBeNull();
    });

    test("Enter mid-row leaves the line alone", () => {
        expect(typedTable(typedState(para({ type: "text", text: "| A |" }), false))).toBeNull();
    });

    test("undo after a typed conversion restores the literal syntax, not the whole typing burst", () => {
        const type = (state, text) => state.apply(state.tr.insertText(text));
        const undone = state => { undo(state, tr => { state = state.apply(tr); }); return state; };
        const empty = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph" }] });
        let state = type(EditorState.create({ doc: empty, plugins: [history()] }), "See [docs](https://example.com/a");
        const [insert, convert] = typedLink(state, state.selection.from, state.selection.from, ")");
        expect(undone(state.apply(insert).apply(convert)).doc.textContent).toBe("See [docs](https://example.com/a)");
        state = type(EditorState.create({ doc: empty, plugins: [history()] }), "| A | B |");
        expect(undone(state.apply(typedTable(state))).doc.textContent).toBe("| A | B |");
    });
});
