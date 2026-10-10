import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityError } from "../../src/modules/identity/errors";

const mocks = vi.hoisted(() => ({
  requireActor: vi.fn(),
  captureSafeFailure: vi.fn(),
  flush: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../src/modules/identity/session", () => ({ requireActor: mocks.requireActor }));
vi.mock("../../src/lib/observability/capture", () => ({
  captureSafeFailure: mocks.captureSafeFailure,
}));
vi.mock("@sentry/nextjs", () => ({ flush: mocks.flush }));

import { authorizeDiagnostics, runServerDiagnostic } from "../../src/app/sentry-example-page/actions";

const operator = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  role: "Admin" as const,
};
const member = { ...operator, role: "Member" as const };
const expiresAt = "2026-10-04T18:00:00Z";
const receipt = {
  correlationId: "30000000-0000-4000-8000-000000000001",
  eventId: "a".repeat(32),
};

function enableDiagnostics() {
  vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_ENABLED", "1");
  vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS", operator.userId);
  vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT", expiresAt);
}

describe("diagnostics server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_ENABLED", "0");
    vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS", "");
    vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT", "");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-04T17:00:00Z"));
    mocks.requireActor.mockResolvedValue(operator);
    mocks.captureSafeFailure.mockReturnValue(receipt);
    mocks.flush.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("authorizes only the current persisted operator and returns the configured expiry", async () => {
    enableDiagnostics();

    await expect(authorizeDiagnostics()).resolves.toEqual({ ok: true, data: { expiresAt } });
    expect(mocks.requireActor).toHaveBeenCalledOnce();
  });

  it("does not emit when configuration is disabled, malformed, or expired", async () => {
    mocks.requireActor.mockResolvedValue(operator);
    await expect(authorizeDiagnostics()).resolves.toMatchObject({ ok: false });

    enableDiagnostics();
    vi.stubEnv("KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT", "2026-10-04T18:00:00");
    await expect(runServerDiagnostic()).resolves.toMatchObject({ ok: false });

    enableDiagnostics();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt));
    await expect(runServerDiagnostic()).resolves.toMatchObject({ ok: false });
    expect(mocks.captureSafeFailure).not.toHaveBeenCalled();
  });

  it("reauthorizes on submit after a persisted role change and ignores a forged actor payload", async () => {
    enableDiagnostics();
    mocks.requireActor.mockResolvedValueOnce(operator).mockResolvedValueOnce(member);

    await expect(authorizeDiagnostics()).resolves.toMatchObject({ ok: true });
    const forgedCall = runServerDiagnostic as unknown as (payload: unknown) => ReturnType<typeof runServerDiagnostic>;
    await expect(forgedCall({ actor: operator })).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(mocks.captureSafeFailure).not.toHaveBeenCalled();
  });

  it("does not emit when the verified session is expired", async () => {
    enableDiagnostics();
    mocks.requireActor.mockRejectedValue(new IdentityError("UNAUTHENTICATED"));

    await expect(authorizeDiagnostics()).resolves.toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    await expect(runServerDiagnostic()).resolves.toMatchObject({ ok: false });
    expect(mocks.captureSafeFailure).not.toHaveBeenCalled();
  });

  it("does not let an added actor payload authorize a non-operator", async () => {
    enableDiagnostics();
    mocks.requireActor.mockResolvedValue(member);

    const forgedCall = runServerDiagnostic as unknown as (payload: unknown) => ReturnType<typeof runServerDiagnostic>;
    await expect(forgedCall({ actor: operator, userId: operator.userId })).resolves.toMatchObject({ ok: false });
    expect(mocks.captureSafeFailure).not.toHaveBeenCalled();
  });

  it("emits only the fixed synthetic event and reports bounded flush state", async () => {
    enableDiagnostics();

    await expect(runServerDiagnostic()).resolves.toEqual({
      ok: true,
      data: { ...receipt, flushed: true },
    });
    expect(mocks.captureSafeFailure).toHaveBeenCalledWith({
      module: "application",
      operation: "diagnostic",
      code: "INTERNAL_ERROR",
      synthetic: true,
    });
    expect(mocks.flush).toHaveBeenCalledWith(2000);
  });

  it("returns a non-confirming result when Sentry does not flush", async () => {
    enableDiagnostics();
    mocks.flush.mockResolvedValue(false);

    await expect(runServerDiagnostic()).resolves.toMatchObject({
      ok: true,
      data: { correlationId: receipt.correlationId, flushed: false },
    });
  });
});
