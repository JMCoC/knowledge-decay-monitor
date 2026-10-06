import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { runProcessing } from "@/modules/ingestion/processing";

// Placeholder for the Task 4 stub. Task 5 replaces this file with the real
// worker tests (success + NO_TEXT + overflow + embed/RPC/timeout mapping).
describe("runProcessing stub", () => {
  it("resolves without doing the CAS (owned by the Route Handler)", async () => {
    await expect(
      runProcessing(
        "30000000-0000-4000-8000-000000000001",
        "60000000-0000-4000-8000-000000000001",
      ),
    ).resolves.toBeUndefined();
  });
});
