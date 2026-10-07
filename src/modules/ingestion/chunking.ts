import "server-only";

import type { AllowedExtension } from "./validation";

/** Frozen in Task 0: 4.0 chars per token (WordPiece estimate, documented). */
export const CHARS_PER_TOKEN = 4;

/** Frozen in Task 0: versions producing more chunks fail honestly. */
export const MAX_CHUNKS_PER_VERSION = 500;

export interface ParsedSection {
  heading: string | null;
  page: number | null;
  paragraphs: string[];
}

/**
 * One chunk without its embedding. Snake case matches the jsonb contract
 * that `finish_processing` consumes; Task 5 appends `embedding`.
 */
export interface ChunkDraft {
  chunk_index: number;
  text_content: string;
  page_number: number | null;
  section_heading: string | null;
}

export type ParseErrorCode = "NO_TEXT" | "CHUNK_LIMIT_EXCEEDED" | "EXTRACTION_FAILED" | "UNSUPPORTED_FORMAT";

/** Controlled pipeline failure. Task 5 maps `code` to the Sentry taxonomy. */
export class ParseError extends Error {
  readonly code: ParseErrorCode;

  constructor(code: ParseErrorCode, message: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

/**
 * Injected byte readers so unit tests never touch Storage, the network, or
 * parser dependencies. Production passes no loaders and gets dynamic imports.
 */
export interface DocumentLoaders {
  extractPdfText?: (bytes: Uint8Array) => Promise<string[]>;
  convertDocxToHtml?: (bytes: Uint8Array) => Promise<string>;
}

function defaultLoaders(): Required<DocumentLoaders> {
  // String (never literal) dynamic imports: no static dependency on parser
  // packages, so this module typechecks before `pnpm add unpdf mammoth`
  // (required before Task 7) and stays out of any client bundle.
  return {
    extractPdfText: async (bytes: Uint8Array) => {
      const moduleName = "unpdf";
      try {
        const mod = await import(moduleName);
        const result = (await mod.extractText(bytes)) as { text: string[] };
        return result.text;
      } catch {
        throw new ParseError("EXTRACTION_FAILED", "The PDF parser is unavailable or failed.");
      }
    },
    convertDocxToHtml: async (bytes: Uint8Array) => {
      const moduleName = "mammoth";
      try {
        const mod = await import(moduleName);
        const result = (await mod.convertToHtml({ buffer: bytes })) as { value: string };
        return result.value;
      } catch {
        throw new ParseError("EXTRACTION_FAILED", "The DOCX parser is unavailable or failed.");
      }
    },
  };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, "")).trim();
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseMarkdownText(text: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection = { heading: null, page: null, paragraphs: [] };
  let block: string[] = [];
  const flush = () => {
    const paragraph = block.join("\n").trim();
    if (paragraph.length > 0) current.paragraphs.push(paragraph);
    block = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading?.[2]) {
      flush();
      if (current.paragraphs.length > 0 || current.heading !== null) sections.push(current);
      current = { heading: heading[2].trim(), page: null, paragraphs: [] };
    } else if (/^\s*$/.test(line)) {
      flush();
    } else {
      block.push(line);
    }
  }
  flush();
  if (current.paragraphs.length > 0 || current.heading !== null) sections.push(current);
  return sections.filter((section) => section.paragraphs.length > 0);
}

function parseDocxHtml(html: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection = { heading: null, page: null, paragraphs: [] };
  const blocks = html.matchAll(/<(h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/gi);
  for (const match of blocks) {
    const text = stripTags(match[2] ?? "");
    if (text.length === 0) continue;
    if (match[1]?.toLowerCase() !== "p") {
      if (current.paragraphs.length > 0 || current.heading !== null) sections.push(current);
      current = { heading: text, page: null, paragraphs: [] };
    } else {
      current.paragraphs.push(text);
    }
  }
  if (current.paragraphs.length > 0 || current.heading !== null) sections.push(current);
  return sections.filter((section) => section.paragraphs.length > 0);
}

/**
 * Extracts ordered sections from raw bytes. Never touches Storage: the
 * caller (Task 5 worker) already downloaded the canonical object.
 */
export async function parseDocument(
  bytes: Uint8Array,
  extension: AllowedExtension,
  loaders: DocumentLoaders = {},
): Promise<{ sections: ParsedSection[] }> {
  const resolved = { ...defaultLoaders(), ...loaders };
  let sections: ParsedSection[];
  try {
    if (extension === "md") {
      sections = parseMarkdownText(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    } else if (extension === "pdf") {
      const pages = await resolved.extractPdfText(bytes);
      sections = pages
        .map((text, index) => ({
          heading: null,
          page: index + 1,
          paragraphs: splitParagraphs(text),
        }))
        .filter((section) => section.paragraphs.length > 0);
    } else if (extension === "docx") {
      sections = parseDocxHtml(await resolved.convertDocxToHtml(bytes));
    } else {
      throw new ParseError("UNSUPPORTED_FORMAT", "Only PDF, DOCX and Markdown are accepted.");
    }
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("EXTRACTION_FAILED", "The document could not be parsed.");
  }
  if (sections.length === 0) {
    throw new ParseError("NO_TEXT", "The document contains no extractable text.");
  }
  return { sections };
}

function splitOversized(text: string, targetChars: number, overlapChars: number): string[] {
  if (text.length <= targetChars) return [text];
  const step = Math.max(targetChars - overlapChars, 1);
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + targetChars, text.length);
    pieces.push(text.slice(start, end));
    if (end >= text.length) break;
    start += step;
  }
  return pieces;
}

/**
 * Greedy deterministic packing: paragraphs fill each chunk up to the target
 * and only oversized blocks split on their own. A new chunk carries the
 * trailing overlap of the previous one, truncated so no chunk ever exceeds
 * the target. Same input always yields byte-identical chunks.
 */
export function chunkDeterministic(
  sections: ParsedSection[],
  options: { targetTokens?: number; overlapTokens?: number } = {},
): ChunkDraft[] {
  const targetChars = (options.targetTokens ?? 450) * CHARS_PER_TOKEN;
  const overlapChars = (options.overlapTokens ?? 50) * CHARS_PER_TOKEN;
  const chunks: ChunkDraft[] = [];
  let current = "";
  let heading: string | null = null;
  let page: number | null = null;

  const emit = () => {
    if (current.length === 0) return;
    chunks.push({ chunk_index: chunks.length, text_content: current, page_number: page, section_heading: heading });
    current = "";
  };

  const currentTail = (length: number): string => {
    const last = chunks[chunks.length - 1]?.text_content ?? "";
    return last.slice(Math.max(last.length - length, 0));
  };

  const pushPiece = (piece: string, pieceHeading: string | null, piecePage: number | null) => {
    if (current.length === 0) {
      current = piece;
      heading = pieceHeading;
      page = piecePage;
      return;
    }
    if (current.length + 2 + piece.length <= targetChars) {
      current += `\n\n${piece}`;
      return;
    }
    emit();
    // The tail comes from the just-emitted chunk: emit() already cleared
    // `current`, so currentTail reads chunks[chunks.length - 1] instead.
    const room = targetChars - 2 - piece.length;
    const prefix = room >= overlapChars ? currentTail(overlapChars) : room > 0 ? currentTail(room) : "";
    current = prefix.length > 0 ? `${prefix}\n\n${piece}` : piece;
    heading = pieceHeading;
    page = piecePage;
  };

  for (const section of sections) {
    for (const paragraph of section.paragraphs) {
      const text = paragraph.trim();
      if (text.length === 0) continue;
      for (const piece of splitOversized(text, targetChars, overlapChars)) {
        pushPiece(piece, section.heading, section.page);
      }
    }
  }
  emit();

  if (chunks.length > MAX_CHUNKS_PER_VERSION) {
    throw new ParseError(
      "CHUNK_LIMIT_EXCEEDED",
      `The version produced ${chunks.length} chunks, above the ${MAX_CHUNKS_PER_VERSION} limit.`,
    );
  }
  return chunks;
}
