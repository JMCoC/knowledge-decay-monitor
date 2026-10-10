import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
vi.mock("server-only", () => ({}));

import { reserveUploadRecord } from "../../src/modules/ingestion/upload-store";
import {
  assertLocalSupabaseReady,
  cleanupLocalUser,
  getLocalUploadMode,
  insertLocalActiveVersion,
  insertLocalProfile,
  newLocalUser,
  setLocalUploadMode,
} from "../support/local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";

type LocalUser = Awaited<ReturnType<typeof newLocalUser>>;

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function bootstrap(user: LocalUser, workspaceName: string) {
  const { data, error } = await user.client.rpc("bootstrap_workspace", {
    workspace_name: workspaceName,
    full_name: "Tenant isolation fixture admin",
  });
  expect(error).toBeNull();
  if (!data) throw new Error("Local fixture Admin bootstrap did not return a workspace.");
  return data;
}

function addRoleProfile(user: LocalUser, workspaceId: string, role: "QA Lead" | "Member") {
  insertLocalProfile({
    userId: user.userId,
    workspaceId,
    role,
    fullName: `Tenant isolation ${role}`,
    email: user.email,
  });
}

describe("tenant and role authorization against local PostgREST", () => {
  let previousUploadMode: "paused" | "active";

  beforeAll(async () => {
    await assertLocalSupabaseReady();
    previousUploadMode = getLocalUploadMode();
    setLocalUploadMode("active");
  });

  afterAll(() => setLocalUploadMode(previousUploadMode));

  it("keeps both workspace directions isolated and enforces each role's database permissions", async () => {
    const service = serviceClient();
    const users: LocalUser[] = [];
    let workspaceA: string | undefined;
    let workspaceB: string | undefined;

    const createUser = async () => {
      const user = await newLocalUser();
      users.push(user);
      return user;
    };

    try {
      const adminA = await createUser();
      const qaA = await createUser();
      const memberA = await createUser();
      const adminB = await createUser();
      const qaB = await createUser();
      const memberB = await createUser();
      const workspaceNameA = `kdm-${randomUUID()}`;
      const workspaceNameB = `kdm-${randomUUID()}`;
      const [workspaceAId, workspaceBId] = await Promise.all([
        bootstrap(adminA, workspaceNameA),
        bootstrap(adminB, workspaceNameB),
      ]);
      workspaceA = workspaceAId;
      workspaceB = workspaceBId;
      addRoleProfile(qaA, workspaceAId, "QA Lead");
      addRoleProfile(memberA, workspaceAId, "Member");
      addRoleProfile(qaB, workspaceBId, "QA Lead");
      addRoleProfile(memberB, workspaceBId, "Member");

      const documentA = randomUUID();
      const documentB = randomUUID();
      const versionA = randomUUID();
      const versionB = randomUUID();
      const chunkA = randomUUID();
      const chunkB = randomUUID();
      const attemptItem = {
        userId: adminA.userId,
        idempotencyKey: randomUUID(),
        requestFingerprint: "b".repeat(64),
        name: `Pending fixture ${randomUUID()}`,
        category: "SOP" as const,
        ownerId: adminA.userId,
        extension: "md" as const,
        sizeBytes: 1,
        sha256: "a".repeat(64),
      };

      const { error: documentsError } = await service.from("documents").insert([
        {
          id: documentA,
          workspace_id: workspaceAId,
          name: "Workspace A private fixture",
          category: "SOP",
          owner_id: memberA.userId,
        },
        {
          id: documentB,
          workspace_id: workspaceBId,
          name: "Workspace B private fixture",
          category: "SOP",
          owner_id: memberB.userId,
        },
      ]);
      expect(documentsError).toBeNull();
      insertLocalActiveVersion({ workspaceId: workspaceAId, documentId: documentA, versionId: versionA });
      insertLocalActiveVersion({ workspaceId: workspaceBId, documentId: documentB, versionId: versionB });
      const vector = `[${Array.from({ length: 384 }, () => 0).join(",")}]`;
      const { error: chunksError } = await service.from("document_chunks").insert([
        {
          id: chunkA,
          workspace_id: workspaceAId,
          version_id: versionA,
          chunk_index: 0,
          text_content: "Private fixture text A",
          embedding: vector,
        },
        {
          id: chunkB,
          workspace_id: workspaceBId,
          version_id: versionB,
          chunk_index: 0,
          text_content: "Private fixture text B",
          embedding: vector,
        },
      ]);
      expect(chunksError).toBeNull();

      const reserved = await reserveUploadRecord(attemptItem);

      const actors = [
        { user: adminA, workspaceId: workspaceAId, role: "Admin" as const },
        { user: qaA, workspaceId: workspaceAId, role: "QA Lead" as const },
        { user: memberA, workspaceId: workspaceAId, role: "Member" as const },
        { user: adminB, workspaceId: workspaceBId, role: "Admin" as const },
        { user: qaB, workspaceId: workspaceBId, role: "QA Lead" as const },
        { user: memberB, workspaceId: workspaceBId, role: "Member" as const },
      ];

      for (const actor of actors) {
        const expectedDocuments = actor.role === "Member"
          ? 0
          : actor.workspaceId === workspaceAId ? 2 : 1;
        const expectedProfiles = actor.role === "Member" ? 1 : 3;
        const expectedChunks = actor.role === "Member" ? 0 : 1;
        const [workspaces, profiles, documents, versions, chunks, attempts] = await Promise.all([
          actor.user.client.from("workspaces").select("id,name"),
          actor.user.client.from("profiles").select("id,workspace_id,role"),
          actor.user.client.from("documents").select("id,workspace_id"),
          actor.user.client.from("document_versions").select("id,workspace_id,document_id,upload_state"),
          actor.user.client.from("document_chunks").select("id,workspace_id,version_id"),
          actor.user.client.from("document_upload_attempts").select("version_id"),
        ]);
        for (const result of [workspaces, profiles, documents, versions, chunks, attempts]) {
          expect(result.error).toBeNull();
        }
        expect(workspaces.data).toHaveLength(1);
        expect(workspaces.data?.[0]?.id).toBe(actor.workspaceId);
        expect(profiles.data).toHaveLength(expectedProfiles);
        expect(profiles.data?.every((profile) => profile.workspace_id === actor.workspaceId)).toBe(true);
        expect(documents.data).toHaveLength(expectedDocuments);
        expect(documents.data?.every((row) => row.workspace_id === actor.workspaceId)).toBe(true);
        expect(versions.data).toHaveLength(expectedDocuments);
        expect(versions.data?.every((row) => row.workspace_id === actor.workspaceId)).toBe(true);
        expect(chunks.data).toHaveLength(expectedChunks);
        expect(chunks.data?.every((row) => row.workspace_id === actor.workspaceId)).toBe(true);
        expect(attempts.data).toHaveLength(actor === actors[0] || actor === actors[1] ? 1 : 0);
      }

      for (const actor of actors) {
        const targetWorkspaceId = actor.workspaceId === workspaceAId ? workspaceBId : workspaceAId;
        const targetDocumentId = actor.workspaceId === workspaceAId ? documentB : documentA;
        const targetVersionId = actor.workspaceId === workspaceAId ? versionB : versionA;
        const targetChunkId = actor.workspaceId === workspaceAId ? chunkB : chunkA;
        const targetProfileId = actor.workspaceId === workspaceAId ? qaB.userId : qaA.userId;
        const forgedVersionId = randomUUID();
        const forgedAttemptId = randomUUID();
        const forgedDocumentId = randomUUID();
        const mutationResults = await Promise.all([
          actor.user.client.from("workspaces").insert({ name: `kdm-${randomUUID()}` }).select("id"),
          actor.user.client.from("workspaces").update({ name: `kdm-${randomUUID()}` })
            .eq("id", targetWorkspaceId).select("id"),
          actor.user.client.from("workspaces").delete().eq("id", targetWorkspaceId).select("id"),
          actor.user.client.from("profiles").insert({
            id: randomUUID(), workspace_id: targetWorkspaceId, role: "Member",
            full_name: "Forged fixture", email: "forged@example.test",
          }).select("id"),
          actor.user.client.from("profiles").update({ role: "Admin" })
            .eq("id", targetProfileId).select("id"),
          actor.user.client.from("profiles").delete().eq("id", targetProfileId).select("id"),
          actor.user.client.from("documents").insert({
            id: forgedDocumentId, workspace_id: targetWorkspaceId,
            name: "Forged fixture", category: "SOP", owner_id: actor.user.userId,
          }).select("id"),
          actor.user.client.from("documents").update({ name: "Forged fixture" })
            .eq("id", targetDocumentId).select("id"),
          actor.user.client.from("documents").delete().eq("id", targetDocumentId).select("id"),
          actor.user.client.from("document_versions").insert({
            id: forgedVersionId, workspace_id: targetWorkspaceId, document_id: targetDocumentId,
            version_number: 99,
            storage_path: `${targetWorkspaceId}/${targetDocumentId}/${forgedVersionId}/original.md`,
          }).select("id"),
          actor.user.client.from("document_versions").update({ processing_status: "processing" })
            .eq("id", targetVersionId).select("id"),
          actor.user.client.from("document_versions").delete().eq("id", targetVersionId).select("id"),
          actor.user.client.from("document_chunks").insert({
            id: randomUUID(), workspace_id: targetWorkspaceId, version_id: targetVersionId,
            chunk_index: 99, text_content: "Forged fixture", embedding: vector,
          }).select("id"),
          actor.user.client.from("document_chunks").update({ text_content: "Forged fixture" })
            .eq("id", targetChunkId).select("id"),
          actor.user.client.from("document_chunks").delete().eq("id", targetChunkId).select("id"),
          actor.user.client.from("document_upload_attempts").insert({
            id: forgedAttemptId, workspace_id: targetWorkspaceId, version_id: targetVersionId,
            storage_path: `${targetWorkspaceId}/${targetDocumentId}/${targetVersionId}/attempts/${forgedAttemptId}/original.md`,
          }).select("version_id"),
          actor.user.client.from("document_upload_attempts").update({ retired_at: new Date().toISOString() })
            .eq("version_id", reserved.versionId).select("version_id"),
          actor.user.client.from("document_upload_attempts").delete()
            .eq("version_id", reserved.versionId).select("version_id"),
        ]);
        for (const result of mutationResults) {
          expect(result.error || (result.data?.length ?? 0) === 0).toBeTruthy();
        }
      }

      const updatedName = `kdm-${randomUUID()}`;
      const adminRename = await adminA.client.from("workspaces")
        .update({ name: updatedName }).eq("id", workspaceAId).select("id,name");
      expect(adminRename.error).toBeNull();
      expect(adminRename.data).toEqual([{ id: workspaceAId, name: updatedName }]);

      const qaRename = await qaA.client.from("workspaces")
        .update({ name: `kdm-${randomUUID()}` }).eq("id", workspaceAId).select("id");
      expect(qaRename.data).toEqual([]);
      const adminCrossRename = await adminA.client.from("workspaces")
        .update({ name: `kdm-${randomUUID()}` }).eq("id", workspaceBId).select("id");
      expect(adminCrossRename.data).toEqual([]);

      const qaCrossUpdate = await qaA.client.from("documents")
        .update({ name: "Cross tenant mutation attempt" }).eq("id", documentB).select("id");
      const adminCrossUpdate = await adminA.client.from("documents")
        .update({ name: "Cross tenant mutation attempt" }).eq("id", documentB).select("id");
      expect(qaCrossUpdate.data).toEqual([]);
      expect(adminCrossUpdate.data).toEqual([]);
      const memberRoleEscalation = await memberA.client.from("profiles")
        .update({ role: "Admin" }).eq("id", memberA.userId).select("id");
      expect(memberRoleEscalation.error || (memberRoleEscalation.data?.length ?? 0) === 0).toBeTruthy();

      const spoofedDocument = await qaA.client.from("documents").insert({
        workspace_id: workspaceBId,
        name: "Spoofed tenant fixture",
        category: "SOP",
        owner_id: qaA.userId,
      }).select("id");
      expect(spoofedDocument.error).toBeTruthy();
      const crossDelete = await adminA.client.from("documents").delete().eq("id", documentB).select("id");
      expect(crossDelete.error || (crossDelete.data?.length ?? 0) === 0).toBeTruthy();

      const [workspaceStateA, workspaceStateB, documentState, memberState, profileStateA, profileStateB, versionState, chunkState, attemptState] = await Promise.all([
        service.from("workspaces").select("id,name").eq("id", workspaceAId).single(),
        service.from("workspaces").select("id,name").eq("id", workspaceBId).single(),
        service.from("documents").select("id,name,workspace_id").eq("id", documentB).single(),
        service.from("profiles").select("id,role,workspace_id").eq("id", memberA.userId).single(),
        service.from("profiles").select("id,role,workspace_id").eq("id", qaA.userId).single(),
        service.from("profiles").select("id,role,workspace_id").eq("id", qaB.userId).single(),
        service.from("document_versions").select("id,processing_status,version_status")
          .eq("id", versionB).single(),
        service.from("document_chunks").select("id,text_content,workspace_id")
          .eq("id", chunkB).single(),
        service.from("document_upload_attempts").select("version_id,retired_at,cleanup_status")
          .eq("version_id", reserved.versionId).single(),
      ]);
      expect(workspaceStateA.data?.name).toBe(updatedName);
      expect(workspaceStateB.data?.name).toBe(workspaceNameB);
      expect(documentState.data).toMatchObject({ id: documentB, name: "Workspace B private fixture", workspace_id: workspaceBId });
      expect(memberState.data).toMatchObject({ id: memberA.userId, role: "Member", workspace_id: workspaceAId });
      expect(profileStateA.data).toMatchObject({ id: qaA.userId, role: "QA Lead", workspace_id: workspaceAId });
      expect(profileStateB.data).toMatchObject({ id: qaB.userId, role: "QA Lead", workspace_id: workspaceBId });
      expect(versionState.data).toMatchObject({ id: versionB, processing_status: "ready", version_status: "active" });
      expect(chunkState.data).toMatchObject({ id: chunkB, text_content: "Private fixture text B", workspace_id: workspaceBId });
      expect(attemptState.data).toMatchObject({ version_id: reserved.versionId, retired_at: null, cleanup_status: "pending" });

      const privilegedRpc = await qaA.client.rpc("reserve_document_upload", {
        p_user_id: qaA.userId,
        p_idempotency_key: randomUUID(),
        p_request_fingerprint: "c".repeat(64),
        p_name: "Unauthorized direct RPC",
        p_category: "SOP",
        p_owner_id: qaA.userId,
        p_extension: "md",
        p_size_bytes: 1,
        p_expected_sha256: "d".repeat(64),
      });
      expect(privilegedRpc.error).toBeTruthy();
      const otherTenantAttempt = await adminB.client.from("document_upload_attempts")
        .select("version_id").eq("version_id", reserved.versionId);
      expect(otherTenantAttempt.error).toBeNull();
      expect(otherTenantAttempt.data).toEqual([]);
    } finally {
      for (const user of users.slice(1)) {
        await cleanupLocalUser(user.userId);
      }
      for (const user of users.slice(0, 1)) {
        await cleanupLocalUser(user.userId);
      }
      if (workspaceA && workspaceB) {
        const leftovers = await service.from("documents").select("id", { count: "exact", head: true })
          .in("workspace_id", [workspaceA, workspaceB]);
        if (leftovers.count) throw new Error("Synthetic tenant isolation documents were not removed.");
      }
    }
  }, 90_000);
});
