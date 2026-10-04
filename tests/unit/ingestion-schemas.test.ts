import { describe, expect, it } from "vitest";
import {
  finalizeUploadSchema,
  uploadBatchSchema,
  uploadItemSchema,
  uploadReferenceSchema,
} from "@/modules/ingestion/schemas";

const validItem = {
  metadata: {
    name: "Incident response",
    category: "SOP",
    ownerId: "10000000-0000-4000-8000-000000000003",
  },
  fileName: "incident.pdf",
  declaredMimeType: "application/pdf",
  sizeBytes: 2048,
  signature: "JVBERi0xMjM=",
  sha256: "b".repeat(64),
  idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
};

describe("uploadItemSchema", () => {
  it("accepts a well-formed item", () => {
    expect(uploadItemSchema.safeParse(validItem).success).toBe(true);
  });

  it("trims the name rather than rejecting surrounding whitespace", () => {
    const parsed = uploadItemSchema.safeParse({
      ...validItem,
      metadata: { ...validItem.metadata, name: "  Incident response  " },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.metadata.name).toBe("Incident response");
    }
  });

  it("rejects a name that is empty or only whitespace after trimming", () => {
    for (const name of ["", "   ", "\t\n"]) {
      expect(
        uploadItemSchema.safeParse({ ...validItem, metadata: { ...validItem.metadata, name } })
          .success,
      ).toBe(false);
    }
  });

  it("enforces the 200 character boundary after trimming", () => {
    const at = "n".repeat(200);
    const over = "n".repeat(201);
    expect(uploadItemSchema.safeParse({ ...validItem, metadata: { ...validItem.metadata, name: at } }).success).toBe(true);
    expect(uploadItemSchema.safeParse({ ...validItem, metadata: { ...validItem.metadata, name: over } }).success).toBe(false);
  });

  it("rejects a category outside the fixed enum", () => {
    expect(
      uploadItemSchema.safeParse({
        ...validItem,
        metadata: { ...validItem.metadata, category: "Spreadsheet" },
      }).success,
    ).toBe(false);
  });

  it("rejects an owner that is not a uuid", () => {
    expect(
      uploadItemSchema.safeParse({
        ...validItem,
        metadata: { ...validItem.metadata, ownerId: "not-a-uuid" },
      }).success,
    ).toBe(false);
  });

  it("requires a UUID idempotency key and a lowercase SHA-256 digest", () => {
    expect(uploadItemSchema.safeParse({ ...validItem, idempotencyKey: "retry-later" }).success).toBe(false);
    expect(uploadItemSchema.safeParse({ ...validItem, sha256: "A".repeat(64) }).success).toBe(false);
    expect(uploadItemSchema.safeParse({ ...validItem, sha256: "b".repeat(63) }).success).toBe(false);
  });

  it("rejects browser-supplied tenant or actor authority fields", () => {
    expect(uploadItemSchema.safeParse({ ...validItem, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).success).toBe(false);
    expect(uploadItemSchema.safeParse({ ...validItem, role: "Admin" }).success).toBe(false);
    expect(uploadItemSchema.safeParse({ ...validItem, metadata: { ...validItem.metadata, actor: {} } }).success).toBe(false);
  });

  it("accepts a valid one-byte Markdown document with a one-byte signature", () => {
    expect(uploadItemSchema.safeParse({
      ...validItem,
      fileName: "a.md",
      declaredMimeType: "text/markdown",
      sizeBytes: 1,
      signature: "YQ==",
    }).success).toBe(true);
  });

  it("rejects a size outside the bucket limit", () => {
    expect(uploadItemSchema.safeParse({ ...validItem, sizeBytes: 0 }).success).toBe(false);
    expect(uploadItemSchema.safeParse({ ...validItem, sizeBytes: 10_485_760 }).success).toBe(true);
    expect(uploadItemSchema.safeParse({ ...validItem, sizeBytes: 10_485_761 }).success).toBe(false);
  });

  it("rejects an extension outside the allowlist", () => {
    expect(uploadItemSchema.safeParse({ ...validItem, fileName: "a.exe" }).success).toBe(false);
  });

  it("rejects a declared mime that contradicts the extension", () => {
    expect(
      uploadItemSchema.safeParse({ ...validItem, declaredMimeType: "text/markdown" }).success,
    ).toBe(false);
  });

  it("rejects a signature whose bytes contradict the extension", () => {
    const notPdf = Buffer.from("Hello wo", "utf8").toString("base64");
    expect(uploadItemSchema.safeParse({ ...validItem, signature: notPdf }).success).toBe(false);
  });

  it("rejects a malformed signature", () => {
    expect(uploadItemSchema.safeParse({ ...validItem, signature: "nope" }).success).toBe(false);
  });

  it("accepts markdown declared as text/plain, which the bucket tolerates", () => {
    const parsed = uploadItemSchema.safeParse({
      ...validItem,
      fileName: "notes.md",
      declaredMimeType: "text/plain",
      signature: Buffer.from("# Runboo", "utf8").toString("base64"),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("uploadBatchSchema", () => {
  it("accepts 1 and 10 entries", () => {
    expect(uploadBatchSchema.safeParse([validItem]).success).toBe(true);
    expect(uploadBatchSchema.safeParse(Array.from({ length: 10 }, () => validItem)).success).toBe(true);
  });

  it("rejects an empty batch and more than 10 entries", () => {
    expect(uploadBatchSchema.safeParse([]).success).toBe(false);
    expect(uploadBatchSchema.safeParse(Array.from({ length: 11 }, () => validItem)).success).toBe(false);
  });

  // The envelope must not judge entries, or one bad file would fail all ten.
  it("does not validate the entries themselves", () => {
    expect(uploadBatchSchema.safeParse([validItem, { nonsense: true }]).success).toBe(true);
  });
});

describe("uploadReferenceSchema", () => {
  it("accepts a one-byte reference and the ten-MiB boundary", () => {
    expect(uploadReferenceSchema.safeParse({ sizeBytes: 1, sha256: "a".repeat(64), signature: "YQ==" }).success).toBe(true);
    expect(uploadReferenceSchema.safeParse({ sizeBytes: 10_485_760, sha256: "a".repeat(64), signature: "AAAAAAAAAAA=" }).success).toBe(true);
  });

  it("rejects zero bytes, an oversized reference, malformed hashes and non-canonical base64", () => {
    for (const reference of [
      { sizeBytes: 0, sha256: "a".repeat(64), signature: "YQ==" },
      { sizeBytes: 10_485_761, sha256: "a".repeat(64), signature: "YQ==" },
      { sizeBytes: 1, sha256: "A".repeat(64), signature: "YQ==" },
      { sizeBytes: 1, sha256: "a".repeat(64), signature: "YR==" },
    ]) {
      expect(uploadReferenceSchema.safeParse(reference).success).toBe(false);
    }
  });

  it("rejects unknown authority fields", () => {
    expect(uploadReferenceSchema.safeParse({
      sizeBytes: 1,
      sha256: "a".repeat(64),
      signature: "YQ==",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }).success).toBe(false);
  });
});

describe("finalizeUploadSchema", () => {
  it("accepts only the version and current attempt UUID", () => {
    expect(finalizeUploadSchema.safeParse({
      versionId: "30000000-0000-4000-8000-000000000001",
      attemptId: "50000000-0000-4000-8000-000000000001",
    }).success).toBe(true);
  });

  it("rejects malformed ids and extra caller-supplied paths or roles", () => {
    const valid = {
      versionId: "30000000-0000-4000-8000-000000000001",
      attemptId: "50000000-0000-4000-8000-000000000001",
    };
    expect(finalizeUploadSchema.safeParse({ ...valid, attemptId: "not-a-uuid" }).success).toBe(false);
    expect(finalizeUploadSchema.safeParse({ ...valid, storagePath: "arbitrary" }).success).toBe(false);
    expect(finalizeUploadSchema.safeParse({ ...valid, role: "Admin" }).success).toBe(false);
  });
});
