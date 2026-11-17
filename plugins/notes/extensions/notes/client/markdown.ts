import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdown(markdown: string) {
    return parser.parse(markdown);
}
