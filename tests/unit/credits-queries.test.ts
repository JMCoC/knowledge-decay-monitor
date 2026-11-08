import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/types/contracts";

const { IdentityError, captureOperationFailure, createReadOnlyClient, getIdentityContext, rpc } = vi.hoisted(() => ({
  IdentityError: class IdentityError extends Error {
    constructor(readonly code: "UNAUTHENTICATED" | "WORKSPACE_REQUIRED" | "FORBIDDEN" | "INTERNAL_ERROR") {
      super(code);
    }
  },
  captureOperationFailure: vi.fn(),
  createReadOnlyClient: vi.fn(),
  getIdentityContext: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/supabase/server", () => ({ createReadOnlyClient }));
vi.mock("../../src/modules/identity", () => ({ IdentityError, getIdentityContext }));
vi.mock("../../src/lib/observability/operation-events", () => ({ captureOperationFailure }));

import { getCreditSnapshot, listCreditLedger } from "../../src/modules/credits/queries";

const admin = { userId: "10000000-0000-4000-8000-000000000001", workspaceId: "20000000-0000-4000-8000-000000000001", role: "Admin" as const };
const member = { ...admin, role: "Member" as const };
const qa = { ...admin, role: "QA Lead" as const };
const correlationId = "40000000-0000-4000-8000-000000000001";
const ledgerItem = {
  id: "50000000-0000-4000-8000-000000000001",
  type: "Promotional",
  amount: 50,
  analysisId: null,
  createdAt: "2026-10-10T12:00:00.000Z",
};

function ready(actor: Actor = admin) {
  return { state: "ready" as const, actor, fullName: "Synthetic actor" };
}

describe("credits server queries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    createReadOnlyClient.mockResolvedValue({ rpc });
    getIdentityContext.mockResolvedValue(ready());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses one verified session client to read the snapshot", async () => {
    const client = { rpc };
    createReadOnlyClient.mockResolvedValue(client);
    rpc.mockResolvedValue({ data: { available: 50, reserved: 0 }, error: null, status: 200 });

    await expect(getCreditSnapshot()).resolves.toEqual({
      ok: true,
      data: { available: 50, reserved: 0 },
    });
    expect(getIdentityContext).toHaveBeenCalledWith(client);
    expect(rpc).toHaveBeenCalledWith("get_credit_snapshot");
  });

  it("allows a Member to read only the snapshot", async () => {
    getIdentityContext.mockResolvedValue(ready(member));
    rpc.mockResolvedValue({ data: { available: 50, reserved: 0 }, error: null, status: 200 });

    await expect(getCreditSnapshot()).resolves.toMatchObject({ ok: true, data: { available: 50 } });
    expect(rpc).toHaveBeenCalledWith("get_credit_snapshot");
  });

  it("maps anonymous and onboarding contexts without calling an RPC", async () => {
    getIdentityContext.mockResolvedValueOnce({ state: "anonymous" });
    await expect(getCreditSnapshot()).resolves.toMatchObject({
      ok: false, error: { code: "UNAUTHENTICATED" },
    });

    getIdentityContext.mockResolvedValueOnce({ state: "onboarding", userId: admin.userId });
    await expect(getCreditSnapshot()).resolves.toMatchObject({
      ok: false, error: { code: "FORBIDDEN" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid ledger input before creating a client", async () => {
    await expect(listCreditLedger({ page: 1.5 })).resolves.toMatchObject({
      ok: false, error: { code: "INVALID_INPUT" },
    });
    expect(createReadOnlyClient).not.toHaveBeenCalled();
  });

  it("uses defaults and accepts a valid page for Admin and QA", async () => {
    rpc.mockResolvedValue({
      data: { items: [ledgerItem], total: 1, page: 1, pageSize: 25 }, error: null, status: 200,
    });
    await expect(listCreditLedger({})).resolves.toEqual({
      ok: true,
      data: { items: [ledgerItem], total: 1, page: 1, pageSize: 25 },
    });
    expect(rpc).toHaveBeenCalledWith("list_credit_ledger", { p_page: 1, p_page_size: 25 });

    vi.resetAllMocks();
    createReadOnlyClient.mockResolvedValue({ rpc });
    getIdentityContext.mockResolvedValue(ready(qa));
    rpc.mockResolvedValue({ data: { items: [], total: 9, page: 2, pageSize: 100 }, error: null, status: 200 });
    await expect(listCreditLedger({ page: 2, pageSize: 100 })).resolves.toMatchObject({
      ok: true, data: { items: [], total: 9, page: 2, pageSize: 100 },
    });
  });

  it("denies Member ledger access without making an RPC call", async () => {
    getIdentityContext.mockResolvedValue(ready(member));

    await expect(listCreditLedger({})).resolves.toMatchObject({
      ok: false, error: { code: "FORBIDDEN" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps a role change rejected by the ledger RPC to FORBIDDEN", async () => {
    getIdentityContext.mockResolvedValue(ready(qa));
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "ROLE_SENTINEL" }, status: 403 });

    const result = await listCreditLedger({});
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(JSON.stringify(result)).not.toContain("ROLE_SENTINEL");
    expect(captureOperationFailure).not.toHaveBeenCalled();
  });

  it("maps an expired session returned as HTTP 401 after identity verification", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST301", message: "TOKEN_SENTINEL" }, status: 401 });

    const result = await getCreditSnapshot();
    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(JSON.stringify(result)).not.toContain("TOKEN_SENTINEL");
    expect(captureOperationFailure).not.toHaveBeenCalled();
  });

  it("maps SQLSTATE 22023 to controlled invalid input", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "SQL_SENTINEL" }, status: 400 });
    await expect(listCreditLedger({})).resolves.toMatchObject({
      ok: false, error: { code: "INVALID_INPUT" },
    });
  });

  it.each([
    ["invalid JSON", { available: "50", reserved: 0 }],
    ["null data", null],
  ])("reports %s as a safe internal snapshot failure", async (_reason, data) => {
    vi.stubGlobal("crypto", { randomUUID: () => correlationId });
    rpc.mockResolvedValue({ data, error: null, status: 200 });

    const result = await getCreditSnapshot();
    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't load the credit balance.", correlationId },
    });
    expect(captureOperationFailure).toHaveBeenCalledWith({
      module: "credits", operation: "snapshot", code: "INTERNAL_ERROR", correlationId,
    });
  });

  it("rejects a response page that differs from the validated request", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => correlationId });
    rpc.mockResolvedValue({
      data: { items: [], total: 25, page: 1, pageSize: 25 }, error: null, status: 200,
    });

    await expect(listCreditLedger({ page: 2, pageSize: 25 })).resolves.toMatchObject({
      ok: false, error: { code: "INTERNAL_ERROR" },
    });
    expect(captureOperationFailure).toHaveBeenCalledWith({
      module: "credits", operation: "ledger", code: "INTERNAL_ERROR", correlationId,
    });
  });

  it("contains identity lookup failures and telemetry failures", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => correlationId });
    getIdentityContext.mockRejectedValueOnce(new IdentityError("INTERNAL_ERROR"));
    captureOperationFailure.mockImplementation(() => { throw new Error("TELEMETRY_SENTINEL"); });

    const result = await getCreditSnapshot();
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR", correlationId } });
    expect(JSON.stringify(result)).not.toContain("TELEMETRY_SENTINEL");
  });
});
