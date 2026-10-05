import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError } from "@supabase/supabase-js";
import { login, logout, register, requestPasswordReset } from "../../src/modules/identity/actions";

const mocks = vi.hoisted(() => ({
  createWritableClient: vi.fn(),
  reportAuthFailure: vi.fn(),
}));
const correlationId = "40000000-0000-4000-8000-000000000009";
type AuthMockResult = {
  data: { user: { id: string } | null; session: unknown | null };
  error: Error | null;
};

vi.mock("../../src/lib/supabase/server", () => ({
  createReadOnlyClient: vi.fn(),
  createWritableClient: mocks.createWritableClient,
}));
vi.mock("server-only", () => ({}));
vi.mock("../../src/lib/observability/auth-events", () => ({
  reportAuthFailure: mocks.reportAuthFailure,
}));

function createClient({
  signUpResult = { data: { user: { id: "user-1" }, session: { access_token: "token" } }, error: null },
  signInResult = { data: { user: { id: "user-1" }, session: { access_token: "token" } }, error: null },
  signOutResult = { error: null as Error | null },
  userResult = { data: { user: { id: "user-1" } }, error: null as Error | null },
  profileResult = { data: null as Record<string, unknown> | null, error: null as Error | null },
}: {
  signUpResult?: AuthMockResult;
  signInResult?: AuthMockResult;
  signOutResult?: { error: Error | null };
  userResult?: { data: { user: { id: string } | null }; error: Error | null };
  profileResult?: { data: Record<string, unknown> | null; error: Error | null };
} = {}) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => profileResult),
  };
  const client = {
    auth: {
      signUp: vi.fn(async () => signUpResult),
      signInWithPassword: vi.fn(async () => signInResult),
      signOut: vi.fn(async () => signOutResult),
      resetPasswordForEmail: vi.fn(async () => ({ error: null as Error | null })),
      getUser: vi.fn(async () => userResult),
    },
    from: vi.fn(() => query),
  };
  return client;
}

describe("Identity Auth actions", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not claim registration succeeded when Auth returned no session", async () => {
    mocks.createWritableClient.mockResolvedValue(
      createClient({ signUpResult: { data: { user: { id: "user-1" }, session: null }, error: null } }),
    );

    await expect(
      register({ email: "alex@example.com", password: "secret1", confirmPassword: "secret1" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("sends recovery to the configured environment callback", async () => {
    vi.stubEnv("APP_ORIGIN", "https://knowledge-decay-monitor-git-develop-kdm17.vercel.app");
    const client = createClient();
    mocks.createWritableClient.mockResolvedValue(client);

    await expect(requestPasswordReset({ email: "alex@example.com" })).resolves.toEqual({
      ok: true,
      data: { accepted: true },
    });

    expect(client.auth.resetPasswordForEmail).toHaveBeenCalledWith("alex@example.com", {
      redirectTo: "https://knowledge-decay-monitor-git-develop-kdm17.vercel.app/auth/callback",
    });
  });

  it("uses a neutral message for invalid login credentials", async () => {
    mocks.createWritableClient.mockResolvedValue(
      createClient({
        signInResult: {
          data: { user: null, session: null },
          error: new AuthApiError("Invalid login credentials for alex@example.com", 400, "invalid_credentials"),
        },
      }),
    );

    const result = await login({ email: "alex@example.com", password: "secret1" });

    expect(result).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Invalid email or password." },
    });
    expect(JSON.stringify(result)).not.toContain("alex@example.com");
    expect(mocks.reportAuthFailure).not.toHaveBeenCalled();
  });

  it("does not route a valid login to onboarding when Profile lookup fails", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => correlationId });
    mocks.createWritableClient.mockResolvedValue(
      createClient({ profileResult: { data: null, error: new Error("database unavailable") } }),
    );

    const result = await login({ email: "alex@example.com", password: "secret1" });

    expect(result).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't sign you in. Try again.", correlationId },
    });
    expect(JSON.stringify(result)).not.toContain("onboarding");
    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "login",
      code: "PROFILE_LOOKUP_FAILED",
      correlationId,
    });
  });

  it("does not claim logout succeeded when Auth sign-out fails", async () => {
    mocks.createWritableClient.mockResolvedValue(
      createClient({ signOutResult: { error: new Error("provider unavailable") } }),
    );

    await expect(logout()).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't sign you out. Try again." },
    });
  });

  it("reports only the safe operation code and a generated correlation ID on provider failure", async () => {
    mocks.createWritableClient.mockResolvedValue(
      createClient({
        signUpResult: {
          data: { user: null, session: null },
          error: new Error("EMAIL_SENTINEL PASSWORD_SENTINEL"),
        },
      }),
    );

    await register({
      email: "EMAIL_SENTINEL@example.test",
      password: "PASSWORD_SENTINEL",
      confirmPassword: "PASSWORD_SENTINEL",
    });

    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "register",
      code: "PROVIDER_ERROR",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(JSON.stringify(mocks.reportAuthFailure.mock.calls)).not.toContain("SENTINEL");
  });

  it("reports unexpected login provider failures without sending credentials", async () => {
    mocks.createWritableClient.mockResolvedValue(
      createClient({
        signInResult: {
          data: { user: null, session: null },
          error: new Error("EMAIL_SENTINEL PASSWORD_SENTINEL"),
        },
      }),
    );

    await login({ email: "EMAIL_SENTINEL@example.test", password: "PASSWORD_SENTINEL" });

    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "login",
      code: "PROVIDER_ERROR",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(JSON.stringify(mocks.reportAuthFailure.mock.calls)).not.toContain("SENTINEL");
  });

  it("reports logout provider failures using the safe operation and code", async () => {
    mocks.createWritableClient.mockResolvedValue(
      createClient({ signOutResult: { error: new Error("COOKIE_SENTINEL") } }),
    );

    await logout();

    expect(mocks.reportAuthFailure).toHaveBeenCalledWith({
      operation: "logout",
      code: "PROVIDER_ERROR",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(JSON.stringify(mocks.reportAuthFailure.mock.calls)).not.toContain("SENTINEL");
  });
});
