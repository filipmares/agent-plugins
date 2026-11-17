// Adapted from bholmesdev/hubble.md packages/editor/src/{markdownToProsemirror,prosemirrorToMarkdown}.ts @ cf633b3221b9572f22604168ac77c1ffa921debe, MIT.
// The supported-node mapping is ported; remark replaces the hand-written Markdown escaping.
import type { JSONContent } from "@tiptap/core";
import type { Root, RootContent, PhrasingContent, BlockContent, ListItem } from "mdast";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { parseMarkdown } from "./markdown";

const writer = unified().use(remarkGfm).use(remarkStringify, { bullet: "-", fences: true, emphasis: "*", rule: "-" });
type Mark = NonNullable<JSONContent["marks"]>[number];

export function markdownToDoc(source: string): JSONContent {
    const text = (node: RootContent | PhrasingContent): JSONContent => ({
        type: "text", text: source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? source.length),
    });
    const inline = (nodes: PhrasingContent[], marks: Mark[] = []): JSONContent[] => nodes.flatMap(node => {
        switch (node.type) {
            case "text": return node.value ? [{ type: "text", text: node.value, marks }] : [];
            case "strong": return inline(node.children, [...marks, { type: "bold" }]);
            case "emphasis": return inline(node.children, [...marks, { type: "italic" }]);
            case "delete": return inline(node.children, [...marks, { type: "strike" }]);
            case "inlineCode": return [{ type: "text", text: node.value, marks: [...marks, { type: "code" }] }];
            case "break": return [{ type: "hardBreak", marks }];
            case "link": return inline(node.children, [...marks, { type: "link", attrs: { href: node.url, title: node.title } }]);
            case "image": return [{ type: "image", attrs: { src: node.url, alt: node.alt ?? "", title: node.title }, marks }];
            default: return [{ ...text(node), marks }];
        }
    });
    const block = (node: RootContent): JSONContent => {
        switch (node.type) {
            case "paragraph": return { type: "paragraph", content: inline(node.children) };
            case "heading": return { type: "heading", attrs: { level: node.depth }, content: inline(node.children) };
            case "blockquote": return { type: "blockquote", content: node.children.map(block) };
            case "code": return { type: "codeBlock", attrs: { language: node.lang, meta: node.meta }, content: node.value ? [{ type: "text", text: node.value }] : [] };
            case "thematicBreak": return { type: "horizontalRule" };
            case "list": return {
                type: node.ordered ? "orderedList" : "bulletList", attrs: { start: node.start ?? 1, spread: node.spread },
                content: node.children.map(item => ({
                    type: "listItem", attrs: { checked: item.checked ?? null, spread: item.spread },
                    content: [
                        ...(item.children[0]?.type === "paragraph" ? [] : [{ type: "paragraph" }]),
                        ...item.children.map(block),
                    ],
                })),
            };
            case "table": return {
                type: "table", content: node.children.map((row, i) => ({
                    type: "tableRow", content: row.children.map((cell, j) => ({
                        type: i === 0 ? "tableHeader" : "tableCell", attrs: { align: node.align?.[j] ?? null },
                        content: [{ type: "paragraph", content: inline(cell.children) }],
                    })),
                })),
            };
            default: return { type: "paragraph", content: [text(node)] };
        }
    };
    const content = parseMarkdown(source).children.map(block);
    return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

const sameMark = (a: Mark, b: Mark) => a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
const hasMark = (node: JSONContent | undefined, mark: Mark) => node?.marks?.some(other => sameMark(mark, other));

// Keep boundary whitespace outside emphasis, but retain spaces inside a continuous mark run.
function markWhitespace(nodes: JSONContent[]): JSONContent[] {
    return nodes.flatMap((node, i) => {
        if (node.type !== "text" || !node.text || !node.marks?.length || node.marks.some(mark => mark.type === "code")) return [node];
        const keep = (side: number) => node.marks!.filter(mark => hasMark(nodes[i + side], mark));
        if (/^\s+$/.test(node.text)) return [{ ...node, marks: keep(-1).filter(mark => hasMark(nodes[i + 1], mark)) }];
        const [, before, value, after] = /^(\s*)([\s\S]*?\S)(\s*)$/.exec(node.text)!;
        return [
            ...(before ? [{ ...node, text: before, marks: keep(-1) }] : []),
            { ...node, text: value },
            ...(after ? [{ ...node, text: after, marks: keep(1) }] : []),
        ];
    });
}

function inlineToAst(input: JSONContent[]): PhrasingContent[] {
    const nodes = markWhitespace(input);
    const out: PhrasingContent[] = [];
    for (let i = 0; i < nodes.length;) {
        const node = nodes[i];
        const mark = node.marks?.[0];
        if (mark) {
            const run: JSONContent[] = [];
            do {
                run.push({ ...nodes[i], marks: nodes[i].marks!.filter(other => !sameMark(mark, other)) });
                i++;
            } while (i < nodes.length && hasMark(nodes[i], mark));
            const children = inlineToAst(run);
            if (mark.type === "code") {
                let value = "";
                const flush = () => { if (value) out.push({ type: "inlineCode", value }); value = ""; };
                for (const part of run) {
                    if (part.type === "text") value += part.text ?? "";
                    else { flush(); out.push(...inlineToAst([part])); }
                }
                flush();
            }
            else if (mark.type === "link") out.push({ type: "link", url: mark.attrs?.href ?? "", title: mark.attrs?.title ?? null, children });
            else if (mark.type === "bold" || mark.type === "italic" || mark.type === "strike") {
                out.push({ type: { bold: "strong", italic: "emphasis", strike: "delete" }[mark.type] as "strong" | "emphasis" | "delete", children });
            } else throw new Error(`Cannot save the ${mark.type} format as Markdown. Use Markdown view.`);
        } else {
            i++;
            if (node.type === "text") out.push({ type: "text", value: node.text ?? "" });
            else if (node.type === "hardBreak") out.push({ type: "break" });
            else if (node.type === "image") out.push({ type: "image", url: node.attrs?.src ?? "", alt: node.attrs?.alt ?? "", title: node.attrs?.title ?? null });
            else throw new Error(`Cannot save ${node.type} inside Markdown text.`);
        }
    }
    return out;
}

function blockToAst(node: JSONContent): BlockContent {
    const content = node.content ?? [];
    switch (node.type) {
        case "paragraph": return { type: "paragraph", children: inlineToAst(content) };
        case "heading": return { type: "heading", depth: node.attrs?.level ?? 1, children: inlineToAst(content) };
        case "blockquote": return { type: "blockquote", children: content.map(blockToAst) };
        case "codeBlock": return { type: "code", lang: node.attrs?.language ?? null, meta: node.attrs?.meta ?? null, value: content.map(n => n.text ?? "").join("") };
        case "horizontalRule": return { type: "thematicBreak" };
        case "bulletList":
        case "orderedList": return {
            type: "list", ordered: node.type === "orderedList", start: node.type === "orderedList" ? node.attrs?.start ?? 1 : null,
            spread: node.attrs?.spread ?? false,
            children: content.map((item): ListItem => ({
                type: "listItem", checked: item.attrs?.checked ?? null, spread: item.attrs?.spread ?? false, children: (item.content ?? []).map(blockToAst),
            })),
        };
        case "table": return {
            type: "table", align: content[0]?.content?.map(cell => cell.attrs?.align ?? null) ?? [],
            children: content.map(row => ({
                type: "tableRow", children: (row.content ?? []).map(cell => {
                    if (cell.content?.length !== 1 || cell.content[0].type !== "paragraph") throw new Error("Table cells need one paragraph. Use Markdown view.");
                    if (cell.content[0].content?.some(part => part.type === "hardBreak" || /[\r\n]/.test(part.text ?? ""))) {
                        throw new Error("Markdown table cells cannot contain line breaks. Undo the line break to save.");
                    }
                    return { type: "tableCell", children: inlineToAst(cell.content[0].content ?? []) };
                }),
            })),
        };
        default: throw new Error(`Cannot save ${node.type} as Markdown. Use Markdown view.`);
    }
}

export function docToMarkdown(doc: JSONContent): string {
    const tree: Root = { type: "root", children: (doc.content ?? []).map(blockToAst) };
    return writer.stringify(tree);
}

function meaning(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(meaning);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "position")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, meaning(child)]));
    }
    return value;
}

export function sameMeaning(before: string, after: string) {
    return JSON.stringify(meaning(parseMarkdown(before))) === JSON.stringify(meaning(parseMarkdown(after)));
}

export function roundTripSafe(source: string, doc: JSONContent) {
    // These syntaxes have no v1 editing model even if CommonMark sees them as plain text.
    if (/\[\[[^\]\n]+\]\]|\$\$[\s\S]*?\$\$|(^|[^\\])\$[^$\n]+\$|^\s*(`{3,}|~{3,})mermaid\b/m.test(source)) return false;
    return sameMeaning(source, docToMarkdown(doc));
}

// Retain the exact source for unchanged top-level blocks (notably existing title lines).
export function serializeEdit(doc: JSONContent, original: string, baseline: JSONContent): string {
    if (JSON.stringify(doc) === JSON.stringify(baseline)) return original;
    const ast = parseMarkdown(original);
    const before = baseline.content ?? [];
    const after = doc.content ?? [];
    const used = new Set<number>();
    const retained = after.map(node => {
        const index = before.findIndex((old, i) => !used.has(i) && JSON.stringify(old) === JSON.stringify(node));
        const source = index < 0 ? undefined : ast.children[index];
        if (source?.position) {
            used.add(index);
            return original.slice(source.position.start.offset, source.position.end.offset);
        }
        return docToMarkdown({ type: "doc", content: [node] }).replace(/\n$/, "");
    }).join("\n\n") + (original.endsWith("\n") ? "\n" : "");
    const canonical = docToMarkdown(doc);
    // Adjacent lists/quotes need serializer-chosen separators after structural edits.
    return sameMeaning(retained, canonical) ? retained : canonical;
}
