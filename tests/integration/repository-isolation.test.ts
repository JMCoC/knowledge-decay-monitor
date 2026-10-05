import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { IdentityError } from "../../src/modules/identity/errors";
import {
  assertLocalSupabaseReady,
  cleanupLocalUser,
  insertLocalActiveVersion,
  insertMemberProfile,
  newLocalUser,
  ownWorkspaceId,
} from "../support/local-supabase";

vi.mock("server-only", () => ({}));

import {
  findRepositoryDocuments,
  findVersionStoragePath,
} from "../../src/modules/repository/infrastructure/repository.repository";

const LOCAL_API_URL = "http://127.0.0.1:54321";

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

beforeAll(async () => assertLocalSupabaseReady());
afterAll(() => vi.unstubAllGlobals());

describe("Repository isolation against local PostgREST", () => {
  it("filters the latest version, preserves exact tenant counts, and hides Member Owners", async () => {
    const service = serviceClient();
    let adminA: Awaited<ReturnType<typeof newLocalUser>> | undefined;
    let adminB: Awaited<ReturnType<typeof newLocalUser>> | undefined;
    let member: Awaited<ReturnType<typeof newLocalUser>> | undefined;
    let workspaceA: string | undefined;
    let workspaceB: string | undefined;

    try {
      adminA = await newLocalUser();
      adminB = await newLocalUser();
      member = await newLocalUser();

      const workspaceNameA = `kdm-${randomUUID()}`;
      const workspaceNameB = `kdm-${randomUUID()}`;
      const [bootstrapA, bootstrapB] = await Promise.all([
        adminA.client.rpc("bootstrap_workspace", {
          workspace_name: workspaceNameA,
          full_name: "Repository Admin A",
        }),
        adminB.client.rpc("bootstrap_workspace", {
          workspace_name: workspaceNameB,
          full_name: "Repository Admin B",
        }),
      ]);
      expect(bootstrapA.error).toBeNull();
      expect(bootstrapB.error).toBeNull();
      workspaceA = await ownWorkspaceId(adminA.client, adminA.userId);
      workspaceB = await ownWorkspaceId(adminB.client, adminB.userId);

      insertMemberProfile({
        userId: member.userId,
        workspaceId: workspaceA,
        fullName: "Member Document Owner",
        email: member.email,
      });

      const documentA = randomUUID();
      const documentAWithoutVersions = randomUUID();
      const documentB = randomUUID();
      const versionA2 = randomUUID();
      const sameTimestamp = "2026-10-01T12:00:00.000Z";
      const documents = [
        {
          id: documentA,
          workspace_id: workspaceA,
          name: "Shared Runbook",
          category: "SOP" as const,
          owner_id: member.userId,
          created_at: sameTimestamp,
        },
        {
          id: documentAWithoutVersions,
          workspace_id: workspaceA,
          name: "Shared Runbook",
          category: "Policy" as const,
          owner_id: null,
          created_at: sameTimestamp,
        },
        {
          id: documentB,
          workspace_id: workspaceB,
          name: "Workspace B Private Runbook",
          category: "SOP" as const,
          owner_id: adminB.userId,
          created_at: sameTimestamp,
        },
      ];
      const { error: documentsError } = await service.from("documents").insert(documents);
      expect(documentsError).toBeNull();

      insertLocalActiveVersion({ workspaceId: workspaceA, documentId: documentA, versionId: randomUUID() });
      const versionA1 = await service.from("document_versions")
        .select("id").eq("document_id", documentA).eq("version_status", "active").single();
      expect(versionA1.error).toBeNull();
      expect(versionA1.data?.id).toBeTruthy();
      insertLocalActiveVersion({ workspaceId: workspaceB, documentId: documentB, versionId: randomUUID() });
      const versionB1 = await service.from("document_versions")
        .select("id").eq("document_id", documentB).eq("version_status", "active").single();
      expect(versionB1.error).toBeNull();
      expect(versionB1.data?.id).toBeTruthy();

      const versions = [
        {
          id: versionA2,
          workspace_id: workspaceA,
          document_id: documentA,
          version_number: 2,
          storage_path: `${workspaceA}/${documentA}/${versionA2}/original.md`,
          processing_status: "uploaded" as const,
          version_status: null,
        },
      ];
      const { error: versionsError } = await service.from("document_versions").insert(versions);
      expect(versionsError).toBeNull();

      const firstPage = await findRepositoryDocuments(adminA.client, {
        name: "shared runbook",
        page: 1,
        pageSize: 1,
      });
      const secondPage = await findRepositoryDocuments(adminA.client, {
        name: "Shared Runbook",
        page: 2,
        pageSize: 1,
      });
      expect(firstPage.total).toBe(2);
      expect(secondPage.total).toBe(2);
      expect(firstPage.data).toHaveLength(1);
      expect(secondPage.data).toHaveLength(1);
      expect(firstPage.data[0].id).not.toBeNull();
      expect(secondPage.data[0].id).not.toBeNull();
      expect(String(firstPage.data[0].id).localeCompare(String(secondPage.data[0].id))).toBeGreaterThan(0);

      const outOfRangePage = await findRepositoryDocuments(adminA.client, { page: 3 });
      expect(outOfRangePage).toMatchObject({ data: [], total: 2, page: 3, pageSize: 25 });

      const categoryFilter = await findRepositoryDocuments(adminA.client, { category: "Policy" });
      expect(categoryFilter).toMatchObject({ total: 1, data: [{ id: documentAWithoutVersions }] });

      const ownerFilter = await findRepositoryDocuments(adminA.client, { ownerId: member.userId });
      expect(ownerFilter).toMatchObject({ total: 1, data: [{ id: documentA }] });

      const unassignedFilter = await findRepositoryDocuments(adminA.client, { ownerId: null });
      expect(unassignedFilter).toMatchObject({ total: 1, data: [{ id: documentAWithoutVersions, owner_id: null }] });

      const combinedFilter = await findRepositoryDocuments(adminA.client, {
        name: "shared", category: "Policy", ownerId: null,
      });
      expect(combinedFilter).toMatchObject({ total: 1, data: [{ id: documentAWithoutVersions }] });

      const noMatches = await findRepositoryDocuments(adminA.client, { name: "no matching document" });
      expect(noMatches).toMatchObject({ data: [], total: 0 });

      const activeOnly = await findRepositoryDocuments(adminA.client, {
        name: "Shared Runbook",
        versionStatus: "active",
      });
      expect(activeOnly).toMatchObject({ data: [], total: 0 });

      const nullStatus = await findRepositoryDocuments(adminA.client, {
        name: "Shared Runbook",
        versionStatus: null,
      });
      expect(nullStatus.total).toBe(2);
      const latestPending = nullStatus.data.find((row) => row.id === documentA);
      expect(latestPending).toMatchObject({
        latest_version_id: versionA2,
        latest_version_status: null,
      });

      const privateWorkspaceBSearchAsA = await findRepositoryDocuments(adminA.client, {
        name: "Workspace B Private Runbook",
      });
      expect(privateWorkspaceBSearchAsA).toMatchObject({ data: [], total: 0 });

      const workspaceBResult = await findRepositoryDocuments(adminB.client, {
        name: "Workspace B Private Runbook",
      });
      expect(workspaceBResult).toMatchObject({
        total: 1,
        data: [{ id: documentB }],
      });

      const memberResult = await findRepositoryDocuments(member.client, {
        name: "Shared Runbook",
      });
      expect(memberResult).toMatchObject({ data: [], total: 0 });

      await expect(findVersionStoragePath(adminA.userId, versionA2)).resolves.toBeNull();
      await expect(findVersionStoragePath(member.userId, versionA1.data!.id)).rejects.toMatchObject({
        code: "FORBIDDEN",
      } satisfies Partial<IdentityError>);
    } finally {
      if (member) {
        const { error } = await service.auth.admin.deleteUser(member.userId);
        if (error) throw new Error("Local Member fixture cleanup failed.");
      }
      if (adminB) await cleanupLocalUser(adminB.userId);
      if (adminA) await cleanupLocalUser(adminA.userId);
    }
  });
});
