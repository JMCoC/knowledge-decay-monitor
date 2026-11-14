import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/identity", () => ({ requireDocumentActor: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));

import { IdentityError } from "@/modules/identity/errors";
import { requireDocumentActor } from "@/modules/identity";
import { createServiceClient } from "@/lib/supabase/service";
import { assignFinding, changeFinding, getFindingReview, getRoundDraft, listAssignees } from "./actions";

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

  it("validates strict change commands and derives the reviewer identity on the server", async () => {
    const changed = await changeFinding({
      findingId,
      revision: 1,
      idempotencyKey: "change-status-1",
      change: { field: "status", value: "confirmed" },
      actor: { userId: "60000000-0000-4000-8000-000000000001", role: "Admin" },
    } as never);

    expect(changed).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Some review details are invalid." },
    });
    expect(createServiceClient).not.toHaveBeenCalled();

    rpc.mockResolvedValue({
      data: {
        id: findingId,
        analysisId: "60000000-0000-4000-8000-000000000002",
        type: "contradiction",
        explanation: "Synthetic evidence",
        severityOriginal: "High",
        severityCurrent: "Medium",
        status: "confirmed",
        assignee: { id: actor.userId, fullName: "Reviewer", email: "PRIVATE_EMAIL" },
        createdAt: "2026-11-14T00:00:00Z",
        revision: 2,
        canChangeStatus: true,
        canChangeSeverity: true,
        canAssign: true,
        canPrepareRound: true,
        confidence: 0.99,
      },
      error: null,
    });

    const result = await changeFinding({
      findingId: findingId.toUpperCase(),
      revision: 1,
      idempotencyKey: "change-status-1",
      change: { field: "status", value: "confirmed" },
    });

    expect(rpc).toHaveBeenCalledWith("review_change_finding", {
      p_actor_id: actor.userId,
      p_finding_id: findingId,
      p_revision: 1,
      p_change: { field: "status", value: "confirmed" },
      p_idempotency_key: "change-status-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("confirmed");
      expect(result.data).not.toHaveProperty("confidence");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_EMAIL");
    }
  });

  it("rejects an unauthorized reviewer before the service RPC and sends only a valid assignment", async () => {
    vi.mocked(requireDocumentActor).mockRejectedValue(new IdentityError("FORBIDDEN"));
    const denied = await assignFinding({
      findingId,
      revision: 1,
      assigneeId: null,
      idempotencyKey: "unassign-1",
    });

    expect(denied).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "You don't have permission to access review." },
    });
    expect(createServiceClient).not.toHaveBeenCalled();

    vi.mocked(requireDocumentActor).mockResolvedValue(actor);
    rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "PRIVATE_CONFLICT" } });
    const conflict = await assignFinding({
      findingId,
      revision: 8,
      assigneeId: null,
      idempotencyKey: "unassign-1",
    });

    expect(rpc).toHaveBeenCalledWith("review_assign_finding", {
      p_actor_id: actor.userId,
      p_finding_id: findingId,
      p_revision: 8,
      p_assignee_id: null,
      p_idempotency_key: "unassign-1",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("CONFLICT");
      expect(JSON.stringify(conflict)).not.toContain("PRIVATE_CONFLICT");
    }
  });
});
