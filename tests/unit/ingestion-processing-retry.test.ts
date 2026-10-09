import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  readResult: { data: null as unknown, error: null as unknown },
  claimResult: { data: null as unknown, error: null as unknown },
  calls: [] as Array<[string, ...unknown[]]>,
  updated: false,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => {
    const query = {
      select: (...args: unknown[]) => {
        mocks.calls.push(["select", ...args]);
        return mocks.updated ? Promise.resolve(mocks.claimResult) : query;
      },
      eq: (...args: unknown[]) => {
        mocks.calls.push(["eq", ...args]);
        return query;
      },
      is: (...args: unknown[]) => {
        mocks.calls.push(["is", ...args]);
        return query;
      },
      lt: (...args: unknown[]) => {
        mocks.calls.push(["lt", ...args]);
        return query;
      },
      maybeSingle: () => Promise.resolve(mocks.readResult),
      update: (values: unknown) => {
        mocks.updated = true;
        mocks.calls.push(["update", values]);
        return query;
      },
    };
    return { from: (table: string) => { mocks.calls.push(["from", table]); return query; } };
  },
}));

import { claimProcessingRetry, PROCESSING_LEASE_MS } from "@/modules/ingestion/processing-retry";

const VERSION_ID = "30000000-0000-4000-8000-000000000010";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_OPERATION_ID = "60000000-0000-4000-8000-000000000010";
const NEW_OPERATION_ID = "60000000-0000-4000-8000-000000000011";
const NOW = new Date("2026-10-07T12:00:00.000Z");

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: VERSION_ID,
    workspace_id: WORKSPACE_ID,
    version_number: 1,
    upload_state: "confirmed",
    processing_status: "processing_failed",
    processing_operation_id: null,
    processing_started_at: null,
    version_status: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.updated = false;
  mocks.readResult = { data: version(), error: null };
  mocks.claimResult = { data: [{ processing_operation_id: NEW_OPERATION_ID }], error: null };
});

describe("claimProcessingRetry", () => {
  it("claims a confirmed, unactivated uploaded v1 for its first processing attempt", async () => {
    mocks.readResult = { data: version({ processing_status: "uploaded" }), error: null };

    const result = await claimProcessingRetry({
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      operationId: NEW_OPERATION_ID,
      now: NOW,
    });

    expect(result).toEqual({ kind: "claimed", operationId: NEW_OPERATION_ID });
    expect(mocks.calls).toContainEqual(["eq", "processing_status", "uploaded"]);
    expect(mocks.calls).toContainEqual(["eq", "upload_state", "confirmed"]);
    expect(mocks.calls).toContainEqual(["eq", "version_number", 1]);
    expect(mocks.calls).toContainEqual(["is", "version_status", null]);
    expect(mocks.calls).not.toContainEqual(["eq", "processing_operation_id", OLD_OPERATION_ID]);
  });

  it("claims only a confirmed, unactivated v1 and scopes the CAS to the workspace", async () => {
    const result = await claimProcessingRetry({
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      operationId: NEW_OPERATION_ID,
      now: NOW,
    });

    expect(result).toEqual({ kind: "claimed", operationId: NEW_OPERATION_ID });
    expect(mocks.calls).toContainEqual(["eq", "workspace_id", WORKSPACE_ID]);
    expect(mocks.calls).toContainEqual(["eq", "processing_status", "processing_failed"]);
    expect(mocks.calls).toContainEqual(["eq", "upload_state", "confirmed"]);
    expect(mocks.calls).toContainEqual(["eq", "version_number", 1]);
    expect(mocks.calls).toContainEqual(["is", "version_status", null]);
    expect(mocks.calls).toContainEqual(["update", {
      processing_status: "processing",
      processing_operation_id: NEW_OPERATION_ID,
      processing_started_at: NOW.toISOString(),
    }]);
  });

  it("returns NOT_FOUND for a version outside the verified workspace", async () => {
    mocks.readResult = { data: null, error: null };
    expect(await claimProcessingRetry({
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      operationId: NEW_OPERATION_ID,
      now: NOW,
    })).toEqual({ kind: "not_found" });
    expect(mocks.updated).toBe(false);
  });

  it("does not claim states other than uploaded, processing_failed or an expired processing lease", async () => {
    for (const invalid of [
      { processing_status: "ready" },
      { processing_status: "processing", processing_operation_id: OLD_OPERATION_ID, processing_started_at: NOW.toISOString() },
      { processing_status: "processing", processing_operation_id: null, processing_started_at: "2026-10-07T11:00:00.000Z" },
      { version_number: 2 },
      { upload_state: "pending" },
      { version_status: "active" },
    ]) {
      mocks.readResult = { data: version(invalid), error: null };
      mocks.updated = false;
      mocks.calls.length = 0;
      expect(await claimProcessingRetry({
        workspaceId: WORKSPACE_ID,
        versionId: VERSION_ID,
        operationId: NEW_OPERATION_ID,
        now: NOW,
      })).toEqual({ kind: "conflict" });
      expect(mocks.updated).toBe(false);
    }
  });

  it("reclaims an expired lease with its old operation ID as a compare-and-set guard", async () => {
    const startedAt = new Date(NOW.getTime() - PROCESSING_LEASE_MS - 1).toISOString();
    mocks.readResult = { data: version({
      processing_status: "processing",
      processing_operation_id: OLD_OPERATION_ID,
      processing_started_at: startedAt,
    }), error: null };

    expect(await claimProcessingRetry({
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      operationId: NEW_OPERATION_ID,
      now: NOW,
    })).toEqual({ kind: "claimed", operationId: NEW_OPERATION_ID });
    expect(mocks.calls).toContainEqual(["eq", "processing_operation_id", OLD_OPERATION_ID]);
    expect(mocks.calls).toContainEqual([
      "lt",
      "processing_started_at",
      new Date(NOW.getTime() - PROCESSING_LEASE_MS).toISOString(),
    ]);
  });

  it("returns a conflict when the conditional update loses a concurrent race", async () => {
    mocks.claimResult = { data: [], error: null };
    expect(await claimProcessingRetry({
      workspaceId: WORKSPACE_ID,
      versionId: VERSION_ID,
      operationId: NEW_OPERATION_ID,
      now: NOW,
    })).toEqual({ kind: "conflict" });
  });
});
