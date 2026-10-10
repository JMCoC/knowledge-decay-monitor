import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseMaintenanceArgs,
  resolveMaintenanceRuntime,
  runAttemptCleanup,
} from "../../scripts/upload-maintenance.mjs";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const documentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const versionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const attemptA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const attemptB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const pathA = `${workspaceId}/${documentId}/${versionId}/attempts/${attemptA}/original.md`;
const canonicalPath = `${workspaceId}/${documentId}/${versionId}/original.md`;
const lateAttemptB = `${workspaceId}/${documentId}/${versionId}/attempts/${attemptB}/original.md`;

describe("upload maintenance command safety", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("requires an explicit target and mode and a project ref for linked mode", () => {
    expect(() => parseMaintenanceArgs([])).toThrow("Explicit target and mode are required");
    expect(() => parseMaintenanceArgs(["--target", "linked", "--mode", "apply"]))
      .toThrow("explicit project reference");
    expect(parseMaintenanceArgs(["--target", "local", "--mode", "inspect"])).toEqual({
      target: "local", mode: "inspect", projectRef: undefined,
    });
  });

  it("refuses linked credentials that do not match the explicit linked project", () => {
    const options = parseMaintenanceArgs([
      "--target", "linked", "--mode", "inspect", "--project-ref", "abcdefghijklmnopqrst",
    ]);
    expect(() => resolveMaintenanceRuntime(options, {
      env: {
        KDM_LINKED_SUPABASE_URL: "https://wrongproject.supabase.co",
        KDM_LINKED_SUPABASE_SERVICE_ROLE_KEY: "test-key",
      },
      readLinkedProjectRef: () => "abcdefghijklmnopqrst",
    })).toThrow("destination does not match");
  });

  it("rechecks an already-absent attempt and deletes only its registered path", async () => {
    const attempt = {
      id: attemptA,
      workspace_id: workspaceId,
      version_id: versionId,
      storage_path: pathA,
      retired_at: "2026-10-03T00:00:00Z",
      cleanup_status: "absent",
    };
    const query = {
      select: vi.fn(() => query),
      not: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn(async () => ({ data: [attempt], error: null })),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: attempt, error: null })),
    };
    const remove = vi.fn(async (paths: string[]) => ({ data: paths, error: null }));
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ data: true, error: null }));
    const client = {
      from: vi.fn(() => query),
      storage: { from: vi.fn(() => ({ remove })) },
      rpc,
    };
    const runtime = { url: "http://127.0.0.1:54321", serviceRoleKey: "test-key" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    const result = await runAttemptCleanup(client, runtime, "apply");

    expect(result).toMatchObject({ retired: 1, processed: 1, absent: 1, failed: 0 });
    expect(remove).toHaveBeenCalledWith([pathA]);
    expect(remove).not.toHaveBeenCalledWith([canonicalPath]);
    expect(remove).not.toHaveBeenCalledWith([lateAttemptB]);
    expect(rpc).toHaveBeenCalledWith("mark_upload_attempt_cleanup", {
      p_version_id: versionId,
      p_attempt_id: attemptA,
      p_object_absent: true,
    });
  });

  it("does not call Storage or the marker for an invalid persisted path", async () => {
    const attempt = {
      id: attemptA,
      workspace_id: workspaceId,
      version_id: versionId,
      storage_path: canonicalPath,
      retired_at: "2026-10-03T00:00:00Z",
      cleanup_status: "pending",
    };
    const query = {
      select: vi.fn(() => query),
      not: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn(async () => ({ data: [attempt], error: null })),
      eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: attempt, error: null })),
    };
    const remove = vi.fn();
    const rpc = vi.fn();
    const client = { from: vi.fn(() => query), storage: { from: vi.fn(() => ({ remove })) }, rpc };

    const result = await runAttemptCleanup(client, { url: "http://127.0.0.1:54321", serviceRoleKey: "test-key" }, "apply");

    expect(result.failed).toBe(1);
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
