import { describe, expect, test } from "bun:test";
import { markdownText, parseNote, renameAssetLinks, serializeNote, slug } from "../note-format.mjs";
import { parseMarkdown } from "../vendor/markdown.mjs";

describe("Markdown preservation", () => {
    test("preserves custom mappings, anchors and comments when updating owned metadata", () => {
        const raw = "---\n# Shared anchor\ncustom: &custom\n  value: yes\ncopy: *custom\nupdated: '2020-01-01T00:00:00Z'\n---\n# Note\n";
        const parsed = parseNote(raw);
        const result = serializeNote(parsed, parsed.body, { updated: "2021-01-01T00:00:00Z" });
        expect(parseNote(result).metadata).toMatchObject({ custom: { value: "yes" }, copy: { value: "yes" } });
        expect(result).toContain("# Shared anchor");
        expect(result).toContain("&custom");
        expect(result).toContain("*custom");
        expect(parseNote(result).body).toBe("# Note\n");
    });

    test.each([
        "---\nx: 1\nx: 2\n---\n# Duplicate",
        "---\n- a\n- b\n---\n# Sequence",
        "---\nid: not-a-ulid\n---\n# Reserved",
        "---\nsessions: nope\n---\n# Reserved",
        "---\nx: !unknown value\n---\n# Tag",
        "---\nx: .inf\n---\n# Non-JSON number",
        "---\nx: 9223372036854775807\n---\n# Lossy integer",
        "---\nx: &x [*x]\n---\n# Cyclic alias",
        "---\nx: !!set {a, b}\n---\n# Nested set",
        "---\nx: !!omap [{a: b}]\n---\n# Ordered map",
        "---\n!!set {a, b}\n---\n# Root set",
        "---\nmissing: delimiter",
    ])("refuses to rewrite malformed or incompatible frontmatter", raw => {
        const note = parseNote(raw);
        expect(note.warning.code).toBe("invalid_frontmatter");
        expect(note.body).toBe(raw);
        expect(() => serializeNote(note, note.body, { pinned: true })).toThrow();
    });

    test("search text includes formatted text but not link destinations or Markdown punctuation", () => {
        expect(markdownText("# Title\n**Bold** [label](https://hidden.invalid)\n![alt](pic.png)\n- [x] task"))
            .toBe("Title Bold label alt task");
    });

    test("keeps anchors and comments on managed sequences and resolves aliases before removing a pin", () => {
        const note = parseNote("---\nsessions: &s # Sessions\n  - session-a # Original\ncustom: *s\npinned: &p true\nremember: *p\n---\n# Note");
        const raw = serializeNote(note, note.body, { sessions: ["session-a", "session-b"], pinned: undefined });
        const result = parseNote(raw);
        expect(result.warning).toBeUndefined();
        expect(result.metadata.custom).toEqual(["session-a", "session-b"]);
        expect(result.metadata.remember).toBe(true);
        expect(result.metadata).not.toHaveProperty("pinned");
        expect(raw).toContain("# Sessions");
        expect(raw).toContain("# Original");
    });

    test("rewrites case-variant asset destinations only on case-insensitive filesystems", () => {
        const body = "![image](./OLD.assets/p.png)\n\n[ref]: OLD.assets/file.txt";
        expect(renameAssetLinks(body, "old.assets", "new.assets")).toBe(body);
        expect(renameAssetLinks(body, "old.assets", "new.assets", { caseInsensitive: true }))
            .toBe("![image](./new.assets/p.png)\n\n[ref]: new.assets/file.txt");
    });

    test("patches destination ranges without changing labels, code, nesting or titles", () => {
        const body = [
            "# Assets",
            "[old.assets/example](old.assets/file.txt \"title\")",
            "[`label ]` text](./old.assets/file.txt)",
            "![nested [alt]](old.assets/pic.png)",
            "",
            "[ref]: <old.assets/a.png> 'a title'",
            "",
            "```md",
            "![example](old.assets/no-change.png)",
            "```",
        ].join("\n");
        const updated = renameAssetLinks(body, "old.assets", "new.assets");
        expect(updated).toContain("[old.assets/example](new.assets/file.txt \"title\")");
        expect(updated).toContain("[`label ]` text](./new.assets/file.txt)");
        expect(updated).toContain("![nested [alt]](new.assets/pic.png)");
        expect(updated).toContain("[ref]: <new.assets/a.png> 'a title'");
        expect(updated).toContain("![example](old.assets/no-change.png)");
    });

    test.each(["(", ")"])("preserves encoded unmatched %s in asset destinations", char => {
        const encoded = char === "(" ? "%28" : "%29";
        const body = `![pic](Foo%20${encoded}.assets/p.png)`;
        const updated = renameAssetLinks(body, `Foo ${char}.assets`, `Foo ${char}-2.assets`);
        expect(updated).toBe(`![pic](Foo%20${encoded}-2.assets/p.png)`);
        expect(parseMarkdown(updated).children[0].children).toMatchObject([
            { type: "image", url: `Foo%20${encoded}-2.assets/p.png`, alt: "pic" },
        ]);
    });

    test("keeps Unicode and encoded spaces when changing asset destinations", () => {
        expect(renameAssetLinks("![pic](Work%20Plan.assets/p.png)", "Work Plan.assets", "Work Plan-2.assets"))
            .toBe("![pic](Work%20Plan-2.assets/p.png)");
        expect(renameAssetLinks("![pic](Report%20%231.assets/p%20q.png?x=1#y)", "Report #1.assets", "Report #1-2.assets"))
            .toBe("![pic](Report%20%231-2.assets/p%20q.png?x=1#y)");
        expect(renameAssetLinks("[f](<Q&A #1.assets/f.txt>)", "Q&A #1.assets", "Q&A #1-2.assets"))
            .toBe("[f](<Q&A #1-2.assets/f.txt>)");
        expect(slug("\u010cesk\u00fd pl\u00e1n")).toBe("cesky-plan");
        expect(slug("\u65e5\u672c\u8a9e")).toBe("\u65e5\u672c\u8a9e");
        expect(slug("CON")).toBe("note-con");
    });
});
