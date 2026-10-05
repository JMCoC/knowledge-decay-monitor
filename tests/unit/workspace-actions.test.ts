import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSessionMissingError } from "@supabase/supabase-js";
import {
  createWorkspace,
  reconcileWorkspaceBootstrap,
} from "../../src/modules/workspace/actions";

const mocks = vi.hoisted(() => ({
  createReadOnlyClient: vi.fn(),
  createWritableClient: vi.fn(),
  reportAuthFailure: vi.fn(),
}));
const correlationId = "40000000-0000-4000-8000-000000000009";

vi.mock("../../src/lib/supabase/server", () => ({
  createReadOnlyClient: mocks.createReadOnlyClient,
  createWritableClient: mocks.createWritableClient,
}));
vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/observability/auth-events", () => ({
  reportAuthFailure: mocks.reportAuthFailure,
}));

function createClient({
  user = { id: "verified-user" },
  authError = null,
  rpcResult = { data: "workspace-1", error: null },
  rpcError = null,
  profile = null,
  profileError = null,
}: {
  user?: { id: string } | null;
  authError?: Error | null;
  rpcResult?: {
    data: string | null;
    error: { code?: string; message?: string } | null;
  };
  rpcError?: Error | null;
  profile?: Record<string, unknown> | null;
  profileError?: Error | null;
} = {}) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: profile, error: profileError })),
  };
  const rpc = vi.fn(async () => {
    if (rpcError) throw rpcError;
    return rpcResult;
  });
  const client = {
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: authError })) },
    rpc,
    from: vi.fn(() => query),
  };
  return { client, rpc };
}

describe("createWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("rejects invalid or extra input before creating a client or calling the RPC", async () => {
    const result = await createWorkspace({
      name: "Acme",
      fullName: "Alex",
      role: "Admin",
    } as never);

    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Please check the workspace details and try again." },
    });
    expect(mocks.reportAuthFailure).not.toHaveBeenCalled();
    expect(mocks.createWritableClient).not.toHaveBeenCalled();
  });

  it("sends only trimmed RPC parameters with the verified user's session", async () => {
    const { client, rpc } = createClient();
    mocks.createWritableClient.mockResolvedValue(client);

    await expect(createWorkspace({ name: " Acme ", fullName: " Alex " })).resolves.toEqual({
      ok: true,
      data: { workspaceId: "workspace-1" },
    });
    expect(rpc).toHaveBeenCalledWith("bootstrap_workspace", {
      workspace_name: "Acme",
      full_name: "Alex",
    });
  });

  it.each([
    ["23505", "CONFLICT", "You already belong to a workspace."],
    ["22023", "INVALID_INPUT", "Please check the workspace details and try again."],
  ])("maps bootstrap error %s to a controlled result", async (code, expectedCode, message) => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code, message: "database details" } },
    });
    mocks.createWritableClient.mockResolvedValue(client);

    await expect(createWorkspace({ name: "Acme", fullName: "Alex" })).resolves.toEqual({
      ok: false,
      error: { code: expectedCode, message },
    });
  });

  it("maps a missing verified session to UNAUTHENTICATED", async () => {
    const { client, rpc } = createClient({ user: null, authError: new AuthSessionMissingError() });
    mocks.createWritableClient.mockResolvedValue(client);

    await expect(createWorkspace({ name: "Acme", fullName: "Alex" })).resolves.toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.reportAuthFailure).not.toHaveBeenCalled();
  });

  it("does not call a permission error unauthenticated while Auth still verifies the user", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "42501", message: "permission denied" } },
    });
    mocks.createWritableClient.mockResolvedValue(client);

    await expect(createWorkspace({ name: "Acme", fullName: "Alex" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("reconciles an uncertain RPC response from the persisted Profile", async () => {
    const { client, rpc } = createClient({
      rpcError: new Error("response lost"),
      profile: {
        id: "verified-user",
        workspace_id: "workspace-committed",
        role: "Admin",
        full_name: "Alex",
      },
    });
    mocks.createWritableClient.mockResolvedValue(client);

    await expect(createWorkspace({ name: "Acme", fullName: "Alex" })).resolves.toEqual({
      ok: true,
      data: { workspaceId: "workspace-committed" },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mocks.reportAuthFailure).not.toHaveBeenCalled();
  });

  it("keeps an uncertain bootstrap pending when reconciliation cannot confirm persistence", async () => {
    const { client, rpc } = createClient({
      rpcError: new Error("RESPONSE_LOST_SENTINEL"),
      profileError: new Error("DATABASE_SENTINEL"),
    });
    mocks.createWritableClient.mockResolvedValue(client);

    const result = await createWorkspace({ name: "Acme", fullName: "Alex" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't create your workspace. Try again." },
    });
    expect(result).not.toHaveProperty("data");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mocks.reportAuthFailure).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/SENTINEL/);
  });

  it("does not expose provider or database details on technical failures", async () => {
    const { client } = createClient({ rpcError: new Error("private SQL details") });
    mocks.createWritableClient.mockResolvedValue(client);

    const result = await createWorkspace({ name: "Acme", fullName: "Alex" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't create your workspace. Try again." },
    });
    expect(result.ok ? undefined : result.error.correlationId).toEqual(expect.any(String));
    expect(JSON.stringify(result)).not.toContain("private SQL details");
  });

  it("reports only a safe bootstrap failure code when the RPC fails technically", async () => {
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "XX000", message: "TOKEN_SENTINEL" } },
    });
    mocks.createWritableClient.mockResolvedValue(client);

    await createWorkspace({ name: "Acme", fullName: "Alex" });

    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "bootstrap",
      code: "PROVIDER_ERROR",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(JSON.stringify(mocks.reportAuthFailure.mock.calls)).not.toContain("TOKEN_SENTINEL");
  });

  it("returns the exact support reference sent with the bootstrap failure event", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => correlationId });
    mocks.reportAuthFailure.mockImplementationOnce(() => {
      throw new Error("PRIVATE_TELEMETRY_SENTINEL");
    });
    const { client } = createClient({
      rpcResult: { data: null, error: { code: "XX000", message: "DATABASE_SENTINEL" } },
    });
    mocks.createWritableClient.mockResolvedValue(client);

    const result = await createWorkspace({ name: "Acme", fullName: "Alex" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", correlationId },
    });
    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "bootstrap",
      code: "PROVIDER_ERROR",
      correlationId,
    });
  });

  it("reports ready only when reconciliation confirms a persisted Profile", async () => {
    mocks.createReadOnlyClient.mockResolvedValue(
      createClient({
        profile: {
          id: "verified-user",
          workspace_id: "workspace-committed",
          role: "Admin",
          full_name: "Alex",
        },
      }).client,
    );

    await expect(reconcileWorkspaceBootstrap()).resolves.toEqual({
      ok: true,
      data: { state: "ready" },
    });
  });

  it("allows a retry only after reconciliation confirms no Profile", async () => {
    mocks.createReadOnlyClient.mockResolvedValue(createClient().client);

    await expect(reconcileWorkspaceBootstrap()).resolves.toEqual({
      ok: true,
      data: { state: "onboarding" },
    });
  });

  it("keeps a reconciliation query failure distinct from confirmed onboarding", async () => {
    mocks.createReadOnlyClient.mockResolvedValue(
      createClient({ profileError: new Error("database unavailable") }).client,
    );

    await expect(reconcileWorkspaceBootstrap()).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
  });
});
