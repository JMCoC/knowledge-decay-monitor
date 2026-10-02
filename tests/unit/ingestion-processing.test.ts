import { describe, expect, it } from "vitest";
import { startProcessing } from "@/modules/ingestion/processing";

describe("startProcessing", () => {
  it("is a no-op that leaves the reservation in uploaded", async () => {
    await expect(
      startProcessing("30000000-0000-4000-8000-000000000001", {}),
    ).resolves.toBe("uploaded");
  });
});
