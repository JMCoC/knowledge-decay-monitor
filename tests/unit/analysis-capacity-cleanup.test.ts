import { describe, expect, it } from "vitest";
import { disposeCapacityFixtures } from "../../scripts/analysis-capacity-cleanup.mjs";

describe("analysis capacity fixture cleanup", () => {
  it("attempts every cleanup and reports a sanitized failure", async () => {
    const attempts: string[] = [];
    await expect(disposeCapacityFixtures([
      { dispose: async () => { attempts.push("first"); } },
      { dispose: async () => { attempts.push("second"); throw new Error("private-token"); } },
      { dispose: async () => { attempts.push("third"); } },
    ])).rejects.toThrow("Local capacity fixture cleanup failed for 1 fixture(s).");

    expect(attempts).toEqual(["third", "second", "first"]);
  });

  it("does not fail when all synthetic fixtures are removed", async () => {
    const attempts: number[] = [];
    await expect(disposeCapacityFixtures([
      { dispose: async () => { attempts.push(1); } },
      { dispose: async () => { attempts.push(2); } },
    ])).resolves.toBeUndefined();
    expect(attempts).toEqual([2, 1]);
  });
});
