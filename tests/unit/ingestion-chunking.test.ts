import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  CHARS_PER_TOKEN,
  MAX_CHUNKS_PER_VERSION,
  ParseError,
  chunkDeterministic,
  parseDocument,
  type ParsedSection,
} from "@/modules/ingestion/chunking";

const md = (body: string) => new TextEncoder().encode(body);

describe("parseDocument markdown", () => {
  it("extracts headings and paragraphs in order", async () => {
    const { sections } = await parseDocument(
      md("# Title\n\nFirst paragraph.\n\n## Sub\n\nSecond paragraph.\n"),
      "md",
    );
    expect(sections).toEqual([
      { heading: "Title", page: null, paragraphs: ["First paragraph."] },
      { heading: "Sub", page: null, paragraphs: ["Second paragraph."] },
    ]);
  });

  it("rejects an empty markdown file with NO_TEXT", async () => {
    await expect(parseDocument(md("  \n\n   \n"), "md")).rejects.toMatchObject({
      name: "ParseError",
      code: "NO_TEXT",
    });
  });
});

describe("parseDocument pdf", () => {
  it("maps one section per page and throws NO_TEXT on whitespace-only pages", async () => {
    const loaders = { extractPdfText: async () => ["  \n\n   ", "\n"] };
    await expect(parseDocument(new Uint8Array([1, 2, 3]), "pdf", loaders)).rejects.toMatchObject({
      code: "NO_TEXT",
    });
  });

  it("keeps page numbers on extracted paragraphs", async () => {
    const loaders = { extractPdfText: async () => ["Hello page one.", "Hello page two."] };
    const { sections } = await parseDocument(new Uint8Array([1]), "pdf", loaders);
    expect(sections).toEqual([
      { heading: null, page: 1, paragraphs: ["Hello page one."] },
      { heading: null, page: 2, paragraphs: ["Hello page two."] },
    ]);
  });
});

describe("parseDocument docx", () => {
  it("reads headings and paragraphs from mammoth html", async () => {
    const loaders = {
      convertDocxToHtml: async () =>
        "<h1>Overview</h1><p>First step.</p><p>Second step.</p>",
    };
    const { sections } = await parseDocument(new Uint8Array([1]), "docx", loaders);
    expect(sections).toEqual([
      { heading: "Overview", page: null, paragraphs: ["First step.", "Second step."] },
    ]);
  });

  it("maps a mammoth extraction failure to a controlled ParseError", async () => {
    const loaders = {
      convertDocxToHtml: async () => {
        throw new Error("not a word document");
      },
    };
    await expect(parseDocument(new Uint8Array([0x50, 0x4b]), "docx", loaders)).rejects.toMatchObject({
      name: "ParseError",
    });
  });
});

describe("chunkDeterministic", () => {
  it("is deterministic: same markdown twice yields byte-identical chunks", async () => {
    const bytes = md("# Runbook\n\nAlpha paragraph here.\n\nBeta paragraph here.\n");
    const first = chunkDeterministic((await parseDocument(bytes, "md")).sections);
    const second = chunkDeterministic((await parseDocument(bytes, "md")).sections);
    expect(second).toEqual(first);
  });

  it("packs small paragraphs together and splits only the oversized block", () => {
    const sections: ParsedSection[] = [
      { heading: "H", page: null, paragraphs: ["aaa", "bbb", "ccc", "x".repeat(5000)] },
    ];
    const chunks = chunkDeterministic(sections, { targetTokens: 450, overlapTokens: 50 });
    // "aaa\n\nbbb\n\nccc" fits in one chunk; the 5000-char block splits on its own.
    expect(chunks[0].text_content).toBe("aaa\n\nbbb\n\nccc");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.text_content.length <= 450 * CHARS_PER_TOKEN)).toBe(true);
  });

  it("counts 450/50 through chars/4 and carries the expected overlap", () => {
    const sections: ParsedSection[] = [
      { heading: null, page: null, paragraphs: ["a".repeat(1700), "b".repeat(500)] },
    ];
    const chunks = chunkDeterministic(sections, { targetTokens: 450, overlapTokens: 50 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text_content.length).toBeLessThanOrEqual(450 * CHARS_PER_TOKEN);
    // Second chunk starts with the trailing 200 chars of the first, then the new unit.
    expect(chunks[1].text_content.startsWith("a".repeat(50 * CHARS_PER_TOKEN))).toBe(true);
    expect(chunks[1].text_content.endsWith("b".repeat(500))).toBe(true);
  });

  it("keeps page_number NULL and the nearest section_heading for markdown", () => {
    const sections: ParsedSection[] = [
      { heading: "Title", page: null, paragraphs: ["t".repeat(1700)] },
      { heading: "Sub", page: null, paragraphs: ["s".repeat(1700)] },
    ];
    const chunks = chunkDeterministic(sections, { targetTokens: 450, overlapTokens: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].page_number).toBeNull();
    expect(chunks[0].section_heading).toBe("Title");
    const sub = chunks.find((c) => c.text_content.includes("s".repeat(100)));
    expect(sub?.section_heading).toBe("Sub");
  });

  it("discards empty paragraphs instead of persisting them", () => {
    const sections: ParsedSection[] = [
      { heading: null, page: null, paragraphs: ["   ", "", "real content"] },
    ];
    const chunks = chunkDeterministic(sections);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text_content).toBe("real content");
  });

  it("throws a specific ParseError when the version exceeds MAX_CHUNKS_PER_VERSION", () => {
    const sections: ParsedSection[] = [
      {
        heading: null,
        page: null,
        paragraphs: Array.from({ length: MAX_CHUNKS_PER_VERSION + 10 }, (_, i) => `p${i}`),
      },
    ];
    try {
      chunkDeterministic(sections, { targetTokens: 1, overlapTokens: 0 });
      expect.unreachable("must throw over the chunk cap");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).code).toBe("CHUNK_LIMIT_EXCEEDED");
    }
  });
});
