import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdown(markdown: string) {
    return parser.parse(markdown);
}

type MdastNode = { type: string; value?: string; alt?: string; ordered?: boolean; children?: MdastNode[] };

function plainText(node: MdastNode): string {
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code" || node.type === "html") return node.value ?? "";
    if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
    return node.children ? node.children.map(plainText).join("") : "";
}

// Parse the opening line as CommonMark so heading escapes and character references never leak into titles.
export function markdownTitle(markdown: string): string {
    const first = markdown.split(/\r?\n/, 1)[0];
    if (!first.trim()) return "";
    const plain = /^ {0,3}#{1,6}[ \t]+([^\\&`*_~[\]<>!#]+)$/.exec(first);
    if (plain) return plain[1].trim();
    const tree = parser.parse(first) as MdastNode;
    const ordered = tree.children?.length === 1 && tree.children[0].type === "list" && tree.children[0].ordered;
    const prefix = ordered ? first.match(/^ {0,3}\d+[.)][ \t]*/)?.[0] ?? "" : "";
    return `${prefix}${plainText(tree)}`.replace(/[\r\n]+/g, " ").trim();
}
