import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/contracts";

const { captureOperationFailure, createReadOnlyClient, requireDocumentActor, query } = vi.hoisted(() => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    then: vi.fn(),
  };
  query.select.mockImplementation(() => query);
  query.eq.mockImplementation(() => query);
  query.order.mockImplementation(() => query);
  return {
    query,
    captureOperationFailure: vi.fn(),
    createReadOnlyClient: vi.fn(),
    requireDocumentActor: vi.fn(),
  };
});

vi.mock("../../src/modules/identity", () => ({ requireDocumentActor }));
vi.mock("../../src/lib/supabase/server", () => ({ createReadOnlyClient }));
vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/observability/operation-events", () => ({ captureOperationFailure }));

import { listEligibleOwners } from "../../src/modules/workspace/queries";

const actor: Actor = { userId: "admin-a", workspaceId: "workspace-a", role: "Admin" };
const correlationId = "40000000-0000-4000-8000-000000000009";

describe("workspace eligible owners", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireDocumentActor.mockResolvedValue(actor);
    createReadOnlyClient.mockResolvedValue({ from: vi.fn(() => query) });
    query.select.mockImplementation(() => query);
    query.eq.mockImplementation(() => query);
    query.order.mockImplementation(() => query);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns only profile IDs and names from the verified workspace", async () => {
    query.then.mockImplementation((resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: [{ id: "admin-a", full_name: "Admin A", email: "private@example.test" }],
        error: null,
      }).then(resolve),
    );

    await expect(listEligibleOwners()).resolves.toEqual({
      ok: true,
      data: [{ id: "admin-a", fullName: "Admin A" }],
    });
    expect(query.eq).toHaveBeenCalledWith("workspace_id", actor.workspaceId);
    expect(query.order).toHaveBeenNthCalledWith(1, "full_name", { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, "id", { ascending: true });
  });

  it("returns an internal error when the profile query fails", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => correlationId });
    query.then.mockImplementation((resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: null, error: new Error("database detail") }).then(resolve),
    );

    const result = await listEligibleOwners();

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't load the workspace owners.", correlationId },
    });
    expect(captureOperationFailure).toHaveBeenCalledWith({
      module: "workspace",
      operation: "owners",
      code: "INTERNAL_ERROR",
      correlationId,
    });
  });
});
