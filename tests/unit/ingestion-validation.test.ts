import { describe, expect, it } from "vitest";
import {
  actionCodeForSqlstate,
  canonicalMimeFor,
  decodeSignature,
  extensionFromFileName,
  isDeclaredMimeConsistent,
  isSignatureConsistent,
  isValidFileSize,
} from "@/modules/ingestion/validation";

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x32, 0x33]);
const DOCX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const MD_BYTES = Buffer.from("# Runbook\n", "utf8").subarray(0, 8);
const PLAIN_BYTES = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f]);

describe("extensionFromFileName", () => {
  it("accepts the three allowed extensions regardless of case", () => {
    expect(extensionFromFileName("a.pdf")).toBe("pdf");
    expect(extensionFromFileName("a.PDF")).toBe("pdf");
    expect(extensionFromFileName("a.DocX")).toBe("docx");
    expect(extensionFromFileName("notes.md")).toBe("md");
  });

  it("rejects anything outside the allowlist", () => {
    expect(extensionFromFileName("payload.exe")).toBeNull();
    expect(extensionFromFileName("archive.zip")).toBeNull();
    expect(extensionFromFileName("noextension")).toBeNull();
    expect(extensionFromFileName("trailing.")).toBeNull();
    expect(extensionFromFileName("")).toBeNull();
  });

  it("does not treat a dotted name inside the stem as the extension", () => {
    expect(extensionFromFileName("v1.2.final.pdf")).toBe("pdf");
    expect(extensionFromFileName("report.pdf.txt")).toBeNull();
  });
});

describe("canonicalMimeFor", () => {
  it("never returns what the browser reported", () => {
    expect(canonicalMimeFor("md")).toBe("text/markdown");
    expect(canonicalMimeFor("pdf")).toBe("application/pdf");
    expect(canonicalMimeFor("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});

describe("isDeclaredMimeConsistent", () => {
  it("accepts the single canonical type for pdf and docx", () => {
    expect(isDeclaredMimeConsistent("pdf", "application/pdf")).toBe(true);
    expect(isDeclaredMimeConsistent("pdf", "text/markdown")).toBe(false);
    expect(isDeclaredMimeConsistent("docx", canonicalMimeFor("docx"))).toBe(true);
  });

  it("accepts the markdown variants the bucket tolerates", () => {
    expect(isDeclaredMimeConsistent("md", "text/markdown")).toBe(true);
    expect(isDeclaredMimeConsistent("md", "text/markdown; charset=utf-8")).toBe(true);
    expect(isDeclaredMimeConsistent("md", "text/plain")).toBe(true);
    expect(isDeclaredMimeConsistent("md", "text/plain; charset=utf-8")).toBe(true);
    expect(isDeclaredMimeConsistent("md", "application/pdf")).toBe(false);
    expect(isDeclaredMimeConsistent("md", "")).toBe(false);
  });
});

describe("decodeSignature", () => {
  it("accepts exactly 8 bytes encoded as 12 characters with padding", () => {
    // Wrapped in new Uint8Array because the expectation compares a returned
    // Uint8Array against a Buffer, and those are different constructors.
    expect(decodeSignature(PDF_BYTES.toString("base64"))).toEqual(
      new Uint8Array(PDF_BYTES),
    );
  });

  it("decodes the exact available byte count for small uploads", () => {
    expect(decodeSignature("YQ==", 1)).toEqual(new Uint8Array([0x61]));
    expect(decodeSignature("YQ==", 2)).toBeNull();
  });

  it("rejects non-canonical base64 with unused bits set", () => {
    expect(decodeSignature("YR==", 1)).toBeNull();
  });

  it("rejects the wrong character count", () => {
    expect(decodeSignature("JVBERi0xMjM")).toBeNull();
    expect(decodeSignature("JVBERi0xMjM0")).toBeNull();
    expect(decodeSignature("")).toBeNull();
  });

  it("rejects a missing padding character", () => {
    expect(decodeSignature("JVBERi0xMjMy")).toBeNull();
  });

  it("rejects characters outside the base64 alphabet even at the right length", () => {
    expect(decodeSignature("JVBERi0xMjM*")).toBeNull();
    expect(decodeSignature("JVBE_i0xMjM=")).toBeNull();
  });

  it("rejects base64 that decodes to the wrong number of bytes", () => {
    expect(decodeSignature(Buffer.alloc(4, 1).toString("base64"))).toBeNull();
    expect(decodeSignature(Buffer.alloc(16, 1).toString("base64"))).toBeNull();
  });

  // Guards the client-bundle constraint. A Buffer here would still decode
  // correctly under `environment: "node"`, so every other test in this file
  // would still pass — this is the only assertion that fails if someone
  // reaches for Buffer.from again.
  it("returns a Uint8Array, never a Buffer", () => {
    const bytes = decodeSignature("JVBERi0xMjM=");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(bytes)).toBe(false);
  });
});

describe("isSignatureConsistent", () => {
  it("requires the pdf magic prefix", () => {
    expect(isSignatureConsistent("pdf", PDF_BYTES)).toBe(true);
    expect(isSignatureConsistent("pdf", PLAIN_BYTES)).toBe(false);
  });

  it("requires the zip magic prefix for docx", () => {
    expect(isSignatureConsistent("docx", DOCX_BYTES)).toBe(true);
    expect(isSignatureConsistent("docx", PDF_BYTES)).toBe(false);
  });

  it("does not compare anything for markdown", () => {
    expect(isSignatureConsistent("md", MD_BYTES)).toBe(true);
    expect(isSignatureConsistent("md", PLAIN_BYTES)).toBe(true);
    expect(isSignatureConsistent("md", PDF_BYTES)).toBe(true);
  });
});

describe("isValidFileSize", () => {
  it("accepts the bucket boundary and rejects one byte over", () => {
    expect(isValidFileSize(1)).toBe(true);
    expect(isValidFileSize(10_485_760)).toBe(true);
    expect(isValidFileSize(10_485_761)).toBe(false);
  });

  it("rejects zero, negatives and non-integers", () => {
    expect(isValidFileSize(0)).toBe(false);
    expect(isValidFileSize(-1)).toBe(false);
    expect(isValidFileSize(1.5)).toBe(false);
    expect(isValidFileSize(Number.NaN)).toBe(false);
    expect(isValidFileSize(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("actionCodeForSqlstate", () => {
  it("maps input-shaped failures to INVALID_INPUT", () => {
    expect(actionCodeForSqlstate("22023")).toBe("INVALID_INPUT");
    expect(actionCodeForSqlstate("23503")).toBe("INVALID_INPUT");
  });

  it("maps a policy denial to FORBIDDEN", () => {
    expect(actionCodeForSqlstate("42501")).toBe("FORBIDDEN");
  });

  it("keeps integrity failures as INTERNAL_ERROR", () => {
    expect(actionCodeForSqlstate("23514")).toBe("INTERNAL_ERROR");
  });

  it("maps a duplicate idempotency key to CONFLICT", () => {
    expect(actionCodeForSqlstate("23505")).toBe("CONFLICT");
  });

  it("returns null for anything unrecognised so the caller can report it", () => {
    expect(actionCodeForSqlstate("08006")).toBeNull();
    expect(actionCodeForSqlstate("")).toBeNull();
  });
});
