import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSessionMissingError } from "@supabase/supabase-js";
import { requestPasswordReset, updatePassword } from "../../src/modules/identity/actions";

const mocks = vi.hoisted(() => ({
  createWritableClient: vi.fn(),
  reportAuthFailure: vi.fn(),
}));

vi.mock("../../src/lib/supabase/server", () => ({
  createReadOnlyClient: vi.fn(),
  createWritableClient: mocks.createWritableClient,
}));
vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/observability/auth-events", () => ({
  reportAuthFailure: mocks.reportAuthFailure,
}));

describe("password recovery actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests recovery using the fixed local callback and returns an enumeration-safe result", async () => {
    const resetPasswordForEmail = vi.fn(async () => ({ data: {}, error: null }));
    mocks.createWritableClient.mockResolvedValue({ auth: { resetPasswordForEmail } });

    await expect(requestPasswordReset({ email: " member@example.com " })).resolves.toEqual({
      ok: true,
      data: { accepted: true },
    });
    expect(resetPasswordForEmail).toHaveBeenCalledWith("member@example.com", {
      redirectTo: "http://127.0.0.1:3000/auth/callback",
    });
  });

  it("requires a verified Auth user but does not require a Profile to update the password", async () => {
    const updateUser = vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null }));
    const getUser = vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null }));
    const client = { auth: { updateUser, getUser } };
    mocks.createWritableClient.mockResolvedValue(client);

    await expect(
      updatePassword({ password: " newpass ", confirmPassword: " newpass " }),
    ).resolves.toEqual({ ok: true, data: { updated: true } });
    expect(updateUser).toHaveBeenCalledWith({ password: " newpass " });
    expect(client).not.toHaveProperty("from");
  });

  it("does not update a password without an Auth session", async () => {
    const updateUser = vi.fn();
    mocks.createWritableClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: new AuthSessionMissingError() })),
        updateUser,
      },
    });

    await expect(
      updatePassword({ password: "newpass", confirmPassword: "newpass" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("reports password recovery provider failures without forwarding email or provider text", async () => {
    mocks.createWritableClient.mockResolvedValue({
      auth: {
        resetPasswordForEmail: vi.fn(async () => ({ error: new Error("EMAIL_SENTINEL TOKEN_SENTINEL") })),
      },
    });

    await requestPasswordReset({ email: "EMAIL_SENTINEL@example.test" });

    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "recovery",
      code: "PROVIDER_ERROR",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(JSON.stringify(mocks.reportAuthFailure.mock.calls)).not.toContain("SENTINEL");
  });

  it("reports password update provider failures without forwarding the attempted password", async () => {
    mocks.createWritableClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })),
        updateUser: vi.fn(async () => ({ error: new Error("PASSWORD_SENTINEL TOKEN_SENTINEL") })),
      },
    });

    await updatePassword({ password: "PASSWORD_SENTINEL", confirmPassword: "PASSWORD_SENTINEL" });

    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "password-update",
      code: "PROVIDER_ERROR",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(JSON.stringify(mocks.reportAuthFailure.mock.calls)).not.toContain("SENTINEL");
  });
});
