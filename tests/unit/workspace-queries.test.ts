import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOwnWorkspace } from "../../src/modules/workspace/queries";

const mocks = vi.hoisted(() => ({
  createReadOnlyClient: vi.fn(),
  getIdentityContext: vi.fn(),
}));

vi.mock("../../src/lib/supabase/server", () => ({
  createReadOnlyClient: mocks.createReadOnlyClient,
}));
vi.mock("../../src/modules/identity/session", () => ({
  getIdentityContext: mocks.getIdentityContext,
}));
vi.mock("server-only", () => ({}));

function createClient({
  data = { id: "workspace-from-rls", name: "Acme" } as Record<string, unknown> | null,
  error = null as Error | null,
} = {}) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error })),
  };
  const client = { from: vi.fn(() => query) };
  return { client, query };
}

describe("getOwnWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the verified Actor's workspace ID and returns only presentation fields", async () => {
    const { client, query } = createClient();
    mocks.createReadOnlyClient.mockResolvedValue(client);
    mocks.getIdentityContext.mockResolvedValue({
      state: "ready",
      actor: { userId: "user-1", workspaceId: "workspace-from-rls", role: "Admin" },
      fullName: "Alex",
    });

    await expect(getOwnWorkspace()).resolves.toEqual({
      id: "workspace-from-rls",
      name: "Acme",
    });
    expect(query.eq).toHaveBeenCalledWith("id", "workspace-from-rls");
    expect(query.select).toHaveBeenCalledWith("id, name");
  });

  it("does not invent a Workspace when the authorized row is absent", async () => {
    const { client } = createClient({ data: null });
    mocks.createReadOnlyClient.mockResolvedValue(client);
    mocks.getIdentityContext.mockResolvedValue({
      state: "ready",
      actor: { userId: "user-1", workspaceId: "workspace-1", role: "Admin" },
      fullName: "Alex",
    });

    await expect(getOwnWorkspace()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("keeps a failed workspace query distinct from onboarding", async () => {
    const { client } = createClient({ error: new Error("database unavailable") });
    mocks.createReadOnlyClient.mockResolvedValue(client);
    mocks.getIdentityContext.mockResolvedValue({
      state: "ready",
      actor: { userId: "user-1", workspaceId: "workspace-1", role: "Admin" },
      fullName: "Alex",
    });

    await expect(getOwnWorkspace()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("maps anonymous and onboarding identities to their explicit identity errors", async () => {
    mocks.createReadOnlyClient.mockResolvedValue(createClient().client);
    mocks.getIdentityContext.mockResolvedValueOnce({ state: "anonymous" });
    await expect(getOwnWorkspace()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    mocks.getIdentityContext.mockResolvedValueOnce({ state: "onboarding", userId: "user-1" });
    await expect(getOwnWorkspace()).rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" });
  });
});
