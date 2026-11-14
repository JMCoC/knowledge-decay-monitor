import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  localSupabaseTarget: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync, spawn: mocks.spawn }));
vi.mock("../../tests/support/local-supabase-target", () => ({ localSupabaseTarget: mocks.localSupabaseTarget }));

import { withReviewSqlSessions } from "../../tests/support/review-sql-sessions";

describe("runner-owned review SQL sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.localSupabaseTarget.mockReturnValue({
      apiUrl: "http://127.0.0.1:59001",
      projectId: "kdm-review-0123456789abcdef",
      workdir: "C:/temp/kdm-s3-02-review-123456",
      disposableReview: false,
    });
  });

  it("rejects the checkout stack before inspecting Docker or opening psql", async () => {
    await expect(withReviewSqlSessions(async () => undefined))
      .rejects.toThrow("runner-owned disposable project");
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
