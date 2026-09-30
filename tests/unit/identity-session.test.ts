import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthSessionMissingError } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { getIdentityContext } from "../../src/modules/identity/session";

vi.mock("server-only", () => ({}));

const USER_ID = "user-verified-1";
type MockUser = { id: string; user_metadata?: Record<string, unknown> };

function createClient({
  user = { id: USER_ID, user_metadata: {} },
  authError = null,
  profile = null,
  profileError = null,
}: {
  user?: MockUser | null;
  authError?: Error | null;
  profile?: Record<string, unknown> | null;
  profileError?: Error | null;
} = {}) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: profile, error: profileError })),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: authError })),
    },
    from: vi.fn(() => query),
  } as unknown as SupabaseClient<Database>;

  return { client, query };
}

describe("Identity session context", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies the known missing-session result as anonymous", async () => {
    const noSession = new AuthSessionMissingError();
    const { client } = createClient({ user: null, authError: noSession });

    await expect(getIdentityContext(client)).resolves.toEqual({ state: "anonymous" });
  });

  it("sends a verified user without a Profile to onboarding", async () => {
    const { client, query } = createClient();

    await expect(getIdentityContext(client)).resolves.toEqual({
      state: "onboarding",
      userId: USER_ID,
    });
    expect(query.eq).toHaveBeenCalledWith("id", USER_ID);
  });

  it("builds the Actor only from the persisted Profile, not Auth metadata", async () => {
    const { client } = createClient({
      user: { id: USER_ID, user_metadata: { role: "Admin", workspace_id: "attacker" } },
      profile: {
        id: USER_ID,
        workspace_id: "workspace-from-profile",
        role: "Member",
        full_name: "Persisted Name",
      },
    });

    await expect(getIdentityContext(client)).resolves.toEqual({
      state: "ready",
      actor: {
        userId: USER_ID,
        workspaceId: "workspace-from-profile",
        role: "Member",
      },
      fullName: "Persisted Name",
    });
  });

  it("does not confuse an Auth transport failure with an anonymous session", async () => {
    const { client } = createClient({
      user: null,
      authError: new Error("Auth unavailable"),
    });

    await expect(getIdentityContext(client)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("does not confuse a Profile query failure with an absent Profile", async () => {
    const { client } = createClient({ profileError: new Error("Database unavailable") });

    await expect(getIdentityContext(client)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
