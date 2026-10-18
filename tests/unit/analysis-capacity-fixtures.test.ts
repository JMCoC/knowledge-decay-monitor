import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertLocalSupabaseReady: vi.fn(),
  newLocalUser: vi.fn(),
  ownWorkspaceId: vi.fn(),
  cleanupLocalUser: vi.fn(),
  openLocalSqlSession: vi.fn(),
  sqlQuery: vi.fn(),
  sqlClose: vi.fn(),
}));

vi.mock("../support/local-supabase", () => ({
  assertLocalSupabaseReady: mocks.assertLocalSupabaseReady,
  newLocalUser: mocks.newLocalUser,
  ownWorkspaceId: mocks.ownWorkspaceId,
  cleanupLocalUser: mocks.cleanupLocalUser,
}));
vi.mock("../support/local-sql-session", () => ({
  openLocalSqlSession: mocks.openLocalSqlSession,
}));

import { createAnalysisCapacityFixture } from "../support/analysis-capacity-fixtures";

const userId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "20000000-0000-4000-8000-000000000002";
const workspaceName = "kdm-30000000-0000-4000-8000-000000000003";
const email = `${workspaceName}@example.test`;

function mockAdmin(rpc: ReturnType<typeof vi.fn>) {
  return { userId, email, client: { rpc } };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assertLocalSupabaseReady.mockResolvedValue(undefined);
  mocks.newLocalUser.mockResolvedValue(mockAdmin(
    vi.fn().mockResolvedValue({ data: workspaceId, error: null }),
  ));
  mocks.ownWorkspaceId.mockResolvedValue(workspaceId);
  mocks.cleanupLocalUser.mockResolvedValue(undefined);
  mocks.sqlQuery.mockResolvedValue("");
  mocks.sqlClose.mockResolvedValue(undefined);
  mocks.openLocalSqlSession.mockResolvedValue({
    pid: 1,
    query: mocks.sqlQuery,
    close: mocks.sqlClose,
  });
});

describe("analysis capacity fixture cleanup", () => {
  it("tries workspace cleanup even when closing the SQL session fails", async () => {
    mocks.sqlClose.mockRejectedValue(new Error("private-token"));
    mocks.cleanupLocalUser.mockRejectedValue(new Error("private-token"));
    const fixture = await createAnalysisCapacityFixture({ versionCount: 1, chunksPerVersion: 1 });

    await expect(fixture.dispose()).rejects.toThrow(
      "Local capacity fixture cleanup failed (sql_session,workspace).",
    );
    expect(mocks.sqlQuery).toHaveBeenCalledWith(expect.stringContaining(
      "delete from public.analysis_documents where analysis_id =",
    ));
    expect(mocks.cleanupLocalUser).toHaveBeenCalledWith(userId);
  });

  it("reports failed synthetic cleanup after construction without exposing its error", async () => {
    mocks.newLocalUser.mockResolvedValue(mockAdmin(
      vi.fn().mockResolvedValue({ data: null, error: { code: "BOOTSTRAP_FAILED" } }),
    ));
    mocks.cleanupLocalUser.mockRejectedValue(new Error("private-token"));

    await expect(createAnalysisCapacityFixture({ versionCount: 1, chunksPerVersion: 1 }))
      .rejects.toThrow(
        "Local analysis capacity fixture construction failed; cleanup also failed (1 operation(s)).",
      );
    expect(mocks.cleanupLocalUser).toHaveBeenCalledWith(userId);
    expect(mocks.openLocalSqlSession).not.toHaveBeenCalled();
  });
});
