import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/identity", () => ({ requireActor: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/observability/operation-events", () => ({ captureOperationFailure: vi.fn() }));

import { requireActor } from "@/modules/identity";
import { createServiceClient } from "@/lib/supabase/service";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import { getWorkflowOriginalUrl } from "./repository.actions";

const actor = {
  userId: "50000000-0000-4000-8000-000000000001",
  workspaceId: "60000000-0000-4000-8000-000000000001",
  role: "Member" as const,
};
const versionId = "40000000-0000-4000-8000-000000000001";
const canonicalPath = `${actor.workspaceId}/30000000-0000-4000-8000-000000000001/${versionId}/original.md`;
const signedUrl = "https://storage.example/signed-private-original";

describe("review workflow original Server Action", () => {
  const rpc = vi.fn();
  const createSignedUrl = vi.fn();
  const from = vi.fn();

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockReset();
    createSignedUrl.mockReset();
    from.mockReset();
    vi.mocked(requireActor).mockResolvedValue(actor);
    from.mockReturnValue({ createSignedUrl });
    vi.mocked(createServiceClient).mockReturnValue({ rpc, storage: { from } } as never);
  });

  it("signs only the server-authorized path for 300 seconds and returns its matching expiry", async () => {
    const now = Date.parse("2026-11-18T18:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    rpc.mockResolvedValue({ data: canonicalPath, error: null });
    createSignedUrl.mockResolvedValue({ data: { signedUrl }, error: null });

    const result = await getWorkflowOriginalUrl(versionId);

    expect(rpc).toHaveBeenCalledWith("get_review_workflow_document_path", {
      p_user_id: actor.userId,
      p_version_id: versionId,
    });
    expect(from).toHaveBeenCalledWith("documents");
    expect(createSignedUrl).toHaveBeenCalledWith(canonicalPath, 300);
    expect(result).toEqual({
      ok: true,
      data: { url: signedUrl, expiresAt: new Date(now + 300_000).toISOString() },
    });
  });

  it("returns a controlled denial and never signs after authorization fails", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "PRIVATE_STORAGE_PATH" },
    });

    const result = await getWorkflowOriginalUrl(versionId);

    expect(result).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "You don't have permission to access review." },
    });
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_STORAGE_PATH");
  });

  it("returns NOT_FOUND when the path lookup finds no current permission", async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    const result = await getWorkflowOriginalUrl(versionId);

    expect(result).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "This file is unavailable." },
    });
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("keeps signed-storage failures and telemetry free of paths and URLs", async () => {
    rpc.mockResolvedValue({ data: canonicalPath, error: null });
    createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: `PRIVATE_SIGNED_URL_FAILURE ${canonicalPath} ${signedUrl}` },
    });

    const result = await getWorkflowOriginalUrl(versionId);

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR", message: "We couldn't open this file." } });
    expect(JSON.stringify(result)).not.toContain(canonicalPath);
    expect(JSON.stringify(result)).not.toContain(signedUrl);
    expect(captureOperationFailure).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(captureOperationFailure).mock.calls)).not.toContain(canonicalPath);
    expect(JSON.stringify(vi.mocked(captureOperationFailure).mock.calls)).not.toContain(signedUrl);
  });

  it("rejects malformed version IDs before reading identity or creating a service client", async () => {
    const result = await getWorkflowOriginalUrl("not-a-version-id");

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Some review details are invalid." },
    });
    expect(requireActor).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });
});
