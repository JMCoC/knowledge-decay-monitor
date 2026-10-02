import { beforeAll, describe, expect, it, vi } from "vitest";
import { getIdentityContext } from "../../src/modules/identity/session";
import {
  assertLocalSupabaseReady,
  bootstrapCounts,
  newLocalUser,
  ownWorkspaceId,
} from "../support/local-supabase";

vi.mock("server-only", () => ({}));

beforeAll(async () => assertLocalSupabaseReady());

describe("local Auth and atomic Workspace bootstrap", () => {
  it("serializes concurrent bootstrap calls and persists one Admin Profile", async () => {
    const { client, userId } = await newLocalUser();
    const marker = `kdm-${crypto.randomUUID()}`;

    const results = await Promise.all([
      client.rpc("bootstrap_workspace", { workspace_name: marker, full_name: "Admin One" }),
      client.rpc("bootstrap_workspace", { workspace_name: marker, full_name: "Admin One" }),
    ]);

    expect(results.filter((result) => !result.error)).toHaveLength(1);
    const rejected = results.find((result) => result.error)?.error;
    expect(rejected?.code).toBe("23505");
    const workspaceId = await ownWorkspaceId(client, userId);
    expect(workspaceId).toBe(results.find((result) => !result.error)?.data);
    expect(bootstrapCounts(marker)).toEqual({ workspaceCount: 1, profileCount: 1, adminCount: 1 });

    const context = await getIdentityContext(client);
    expect(context).toMatchObject({
      state: "ready",
      actor: { userId, workspaceId, role: "Admin" },
      fullName: "Admin One",
    });
  });

  it("reconciles a discarded successful RPC response from the persisted Profile", async () => {
    const { client, userId } = await newLocalUser();
    const marker = `kdm-${crypto.randomUUID()}`;

    const committed = await client.rpc("bootstrap_workspace", {
      workspace_name: marker,
      full_name: "Recovery Admin",
    });
    expect(committed.error).toBeNull();
    // Simulate a lost response by intentionally resolving from persisted state only.
    const context = await getIdentityContext(client);

    expect(context).toMatchObject({
      state: "ready",
      actor: { userId, workspaceId: committed.data, role: "Admin" },
      fullName: "Recovery Admin",
    });
    expect(bootstrapCounts(marker)).toEqual({ workspaceCount: 1, profileCount: 1, adminCount: 1 });
  });
});
