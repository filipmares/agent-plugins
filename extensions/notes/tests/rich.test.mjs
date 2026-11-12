import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { markdownToDoc, docToMarkdown, roundTripSafe, sameMeaning, serializeEdit } from "../client/rich-codec.ts";
import { editorExtensions, safeExternal } from "../client/rich-editor.ts";
import { parseMarkdown } from "../client/markdown.ts";

const require = createRequire(new URL("../client/package.json", import.meta.url));
const { getSchema } = require("@tiptap/core");
const schema = getSchema(editorExtensions());
const roundtrip = source => schema.nodeFromJSON(markdownToDoc(source)).toJSON();

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

    test.each(["javascript:alert(1)", "data:image/svg+xml,bad", "file:///C:/x", "//example.com", "https://a\nb", "vscode://x"])("refuses unsafe link %s", url => {
        expect(safeExternal(url)).toBe(false);
    });
});
