import { describe, expect, it } from "vitest";
import { uploadBatchSchema, uploadItemSchema, finalizeBatchSchema } from "./schemas";

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

describe("finalizeBatchSchema", () => {
  it("accepts one to ten uuids", () => {
    const id = "30000000-0000-4000-8000-000000000001";
    expect(finalizeBatchSchema.safeParse([id]).success).toBe(true);
    // Ten distinct ids, not ten copies of one. The schema refuses duplicates,
    // so a repeated literal here would be asserting the opposite of the
    // behaviour the refinement exists for.
    const ten = Array.from(
      { length: 10 },
      (_, index) => `30000000-0000-4000-8000-00000000000${index}`,
    );
    expect(finalizeBatchSchema.safeParse(ten).success).toBe(true);
  });

  it("rejects a non-uuid and an empty batch", () => {
    expect(finalizeBatchSchema.safeParse(["30000000-0000-4000-8000-000000000001x"]).success).toBe(false);
    expect(finalizeBatchSchema.safeParse([]).success).toBe(false);
  });

  it("rejects the same version twice in one call", () => {
    const id = "30000000-0000-4000-8000-000000000001";
    expect(finalizeBatchSchema.safeParse([id, id]).success).toBe(false);
  });
});
