import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/identity", () => ({ requireDocumentActor: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));

import { IdentityError } from "@/modules/identity/errors";
import { requireDocumentActor } from "@/modules/identity";
import { createServiceClient } from "@/lib/supabase/service";
import { getFindingReview, getRoundDraft, listAssignees } from "./actions";

const findingId = "10000000-0000-4000-8000-000000000001";
const actor = {
  userId: "50000000-0000-4000-8000-000000000001",
  workspaceId: "60000000-0000-4000-8000-000000000001",
  role: "QA Lead" as const,
};

describe("review server actions", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireDocumentActor).mockResolvedValue(actor);
    vi.mocked(createServiceClient).mockReturnValue({ rpc } as never);
    rpc.mockReset();
  });

  it("denies browser-supplied actor data and never lets a Member reach the service client", async () => {
    const forged = await listAssignees({
      actor: { userId: actor.userId, workspaceId: actor.workspaceId, role: "Admin" },
    } as never);

    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.error.code).toBe("INVALID_INPUT");
    expect(createServiceClient).not.toHaveBeenCalled();

    vi.mocked(requireDocumentActor).mockRejectedValue(new IdentityError("FORBIDDEN"));
    const member = await listAssignees({});

    expect(member.ok).toBe(false);
    if (!member.ok) expect(member.error.code).toBe("FORBIDDEN");
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("uses server identity and SQL-authorized totals with default pagination", async () => {
    rpc.mockResolvedValue({
      data: {
        items: [{ id: actor.userId, fullName: "Reviewer", email: "PRIVATE_EMAIL" }],
        total: 1,
        page: 1,
        pageSize: 25,
      },
      error: null,
    });

    const result = await listAssignees({});

    expect(requireDocumentActor).toHaveBeenCalledOnce();
    expect(createServiceClient).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("review_list_assignees", {
      p_actor_id: actor.userId,
      p_page: 1,
      p_page_size: 25,
    });
    expect(result).toEqual({
      ok: true,
      data: { items: [{ id: actor.userId, fullName: "Reviewer" }], total: 1, page: 1, pageSize: 25 },
    });
  });

  it("keeps missing and cross-tenant review IDs indistinguishable", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "PRIVATE_MISSING" } });
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "PRIVATE_FOREIGN" } });

    const missing = await getFindingReview({ findingId });
    const foreign = await getFindingReview({ findingId: "10000000-0000-4000-8000-000000000002" });

    expect(missing).toEqual(foreign);
    expect(JSON.stringify(missing)).not.toContain("PRIVATE_");
  });

  it("loads only a current draft snapshot and preserves its selection", async () => {
    const roundId = "20000000-0000-4000-8000-000000000001";
    const snapshot = {
      roundId,
      documentId: "30000000-0000-4000-8000-000000000001",
      mode: "assigned_findings",
      baseActiveVersionId: "40000000-0000-4000-8000-000000000001",
      status: "draft",
      revision: 3,
      createdAt: "2026-11-14T00:00:00Z",
      openedAt: null,
      findingIds: [findingId],
      workspaceId: "PRIVATE_WORKSPACE",
    };
    rpc.mockResolvedValue({ data: snapshot, error: null });

    const result = await getRoundDraft({ roundId });

    expect(rpc).toHaveBeenCalledWith("review_get_round_draft", {
      p_actor_id: actor.userId,
      p_round_id: roundId,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        roundId,
        documentId: snapshot.documentId,
        mode: "assigned_findings",
        baseActiveVersionId: snapshot.baseActiveVersionId,
        status: "draft",
        revision: 3,
        createdAt: snapshot.createdAt,
        openedAt: null,
        findingIds: [findingId],
      },
    });
  });
});
