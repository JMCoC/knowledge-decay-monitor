import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/types/database";
import { createReviewCommandFixture } from "../support/review-command-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { localSupabaseTarget } from "../support/local-supabase-target";

async function expectDenied(request: PromiseLike<{ data: unknown; error: { code?: string } | null }>) {
  const { data, error } = await request;
  expect(data).toBeNull();
  expect(error?.code).toBe("42501");
}

async function currentFinding(fixture: Awaited<ReturnType<typeof createReviewCommandFixture>>, findingId: string) {
  const { data, error } = await fixture.service.from("findings")
    .select("review_revision,status,assignee_id")
    .eq("id", findingId)
    .single();
  if (error || !data) throw new Error("The synthetic review finding snapshot is unavailable.");
  return data;
}

beforeAll(assertLocalSupabaseReady);

describe("review commands through real Auth, PostgREST, and Storage", () => {
  it("authorizes only a verified reviewer and revokes the prior submitter's grouped file", async () => {
    const fixture = await createReviewCommandFixture();
    try {
      const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      if (!publishableKey) throw new Error("The disposable review public key is unavailable.");
      const target = localSupabaseTarget();
      const anonymous = createClient<Database>(target.apiUrl, publishableKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      });
      const findingId = fixture.ids.findingsA.memberA[0];
      const initial = await currentFinding(fixture, findingId);
      const forgedArgs = {
        p_actor_id: fixture.verifiedAdminId,
        p_finding_id: findingId,
        p_revision: initial.review_revision,
        p_assignee_id: fixture.userIds.memberA2,
        p_idempotency_key: `forged-${randomUUID()}`,
      };

      await expectDenied(fixture.memberA.rpc("review_assign_finding", forgedArgs));
      await expectDenied(anonymous.rpc("review_assign_finding", forgedArgs));
      await expectDenied(fixture.service.rpc("review_assign_finding", {
        ...forgedArgs,
        p_actor_id: fixture.userIds.memberA,
        p_idempotency_key: `member-${randomUUID()}`,
      }));

      const initialDownload = await fixture.memberA.storage.from("documents").download(fixture.candidateStoragePath);
      expect(initialDownload.error).toBeTruthy();
      const serviceDownload = await fixture.service.storage.from("documents").download(fixture.candidateStoragePath);
      expect(serviceDownload.error).toBeNull();
      const anaSubmission = await fixture.memberA.from("correction_submissions")
        .select("id,state").eq("id", fixture.candidateSubmissionId);
      expect(anaSubmission).toMatchObject({
        data: [{ id: fixture.candidateSubmissionId, state: "confirmed" }],
        error: null,
      });
      const luisInitialDownload = await fixture.memberA2.storage.from("documents").download(fixture.candidateStoragePath);
      expect(luisInitialDownload.error).toBeTruthy();
      const luisSubmission = await fixture.memberA2.from("correction_submissions")
        .select("id,state").eq("id", fixture.candidateSubmissionId);
      expect(luisSubmission).toMatchObject({ data: [], error: null });

      const candidateFindingIds = fixture.ids.findingsA.memberA;
      for (const candidateFindingId of candidateFindingIds) {
        const finding = await currentFinding(fixture, candidateFindingId);
        const { data, error } = await fixture.service.rpc("review_assign_finding", {
          p_actor_id: fixture.verifiedAdminId,
          p_finding_id: candidateFindingId,
          p_revision: finding.review_revision,
          p_assignee_id: fixture.userIds.memberA2,
          p_idempotency_key: `review-assign-${randomUUID()}`,
        });
        expect(error).toBeNull();
        expect(data).toBeTruthy();
      }

      const anaFindings = await fixture.memberA.from("findings").select("id")
        .in("id", candidateFindingIds);
      expect(anaFindings).toMatchObject({ data: [], error: null });
      const luisFindings = await fixture.memberA2.from("findings").select("id,assignee_id")
        .in("id", [...candidateFindingIds, ...fixture.ids.findingsA.memberA2]);
      expect(luisFindings.error).toBeNull();
      expect(luisFindings.data?.map(({ id }) => id).sort()).toEqual(
        [...candidateFindingIds, ...fixture.ids.findingsA.memberA2].sort(),
      );
      expect(luisFindings.data?.every(({ assignee_id }) => assignee_id === fixture.userIds.memberA2)).toBe(true);
      const anaDownload = await fixture.memberA.storage.from("documents").download(fixture.candidateStoragePath);
      expect(anaDownload.error).toBeTruthy();
      const luisDownload = await fixture.memberA2.storage.from("documents").download(fixture.candidateStoragePath);
      expect(luisDownload.error).toBeTruthy();
      const revokedAnaSubmission = await fixture.memberA.from("correction_submissions")
        .select("id,state").eq("id", fixture.candidateSubmissionId);
      expect(revokedAnaSubmission).toMatchObject({ data: [], error: null });
      const revokedLuisSubmission = await fixture.memberA2.from("correction_submissions")
        .select("id,state").eq("id", fixture.candidateSubmissionId);
      expect(revokedLuisSubmission).toMatchObject({ data: [], error: null });

      const candidateWhileProcessing = await fixture.readCandidateState(fixture.candidateId);
      expect(candidateWhileProcessing).toEqual({
        id: fixture.candidateId,
        status: "processing",
        versionId: fixture.candidateVersionId,
        sourceSubmissionId: fixture.candidateSubmissionId,
        selectedBy: fixture.verifiedAdminId,
      });

      await fixture.completeProcessingCandidate(fixture.candidateId);
      const pendingVersion = await fixture.readVersionState(fixture.candidateVersionId);
      expect(pendingVersion).toEqual({
        id: fixture.candidateVersionId,
        processingStatus: "ready",
        versionStatus: "pending_approval",
      });

      const pendingFinding = await currentFinding(fixture, findingId);
      const pendingAssignment = await fixture.service.rpc("review_assign_finding", {
        p_actor_id: fixture.verifiedAdminId,
        p_finding_id: findingId,
        p_revision: pendingFinding.review_revision,
        p_assignee_id: null as never,
        p_idempotency_key: `pending-unassign-${randomUUID()}`,
      });
      expect(pendingAssignment.error).toBeNull();
      const candidateAfterPendingAssignment = await fixture.readCandidateState(fixture.candidateId);
      expect(candidateAfterPendingAssignment).toEqual({ ...candidateWhileProcessing, status: "pending_approval" });
      const pendingRound = await fixture.readRoundState(fixture.candidateRoundId);
      expect(pendingRound).toMatchObject({ status: "pending_approval", activeCandidateId: fixture.candidateId });
      const finalDownload = await fixture.memberA2.storage.from("documents").download(fixture.candidateStoragePath);
      expect(finalDownload.error).toBeTruthy();
      const persistedFile = await fixture.service.storage.from("documents").download(fixture.candidateStoragePath);
      expect(persistedFile.error).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("supports assignment, unassignment, and a confirmed-to-resolved transition through the command RPCs", async () => {
    const fixture = await createReviewCommandFixture();
    try {
      const findingId = fixture.ids.findingsA.unassigned[0];
      let finding = await currentFinding(fixture, findingId);
      const confirmed = await fixture.service.rpc("review_change_finding", {
        p_actor_id: fixture.verifiedAdminId,
        p_finding_id: findingId,
        p_revision: finding.review_revision,
        p_change: { field: "status", value: "confirmed" },
        p_idempotency_key: `confirm-${randomUUID()}`,
      });
      expect(confirmed.error).toBeNull();

      finding = await currentFinding(fixture, findingId);
      const assigned = await fixture.service.rpc("review_assign_finding", {
        p_actor_id: fixture.verifiedAdminId,
        p_finding_id: findingId,
        p_revision: finding.review_revision,
        p_assignee_id: fixture.userIds.memberA2,
        p_idempotency_key: `assign-${randomUUID()}`,
      });
      expect(assigned.error).toBeNull();

      finding = await currentFinding(fixture, findingId);
      const unassigned = await fixture.service.rpc("review_assign_finding", {
        p_actor_id: fixture.verifiedAdminId,
        p_finding_id: findingId,
        p_revision: finding.review_revision,
        p_assignee_id: null as never,
        p_idempotency_key: `unassign-${randomUUID()}`,
      });
      expect(unassigned.error).toBeNull();

      finding = await currentFinding(fixture, findingId);
      const resolved = await fixture.service.rpc("review_change_finding", {
        p_actor_id: fixture.verifiedAdminId,
        p_finding_id: findingId,
        p_revision: finding.review_revision,
        p_change: { field: "status", value: "resolved" },
        p_idempotency_key: `resolve-${randomUUID()}`,
      });
      expect(resolved.error).toBeNull();
      const finalFinding = await currentFinding(fixture, findingId);
      expect(finalFinding).toMatchObject({ status: "resolved", assignee_id: null });
    } finally {
      await fixture.dispose();
    }
  });
});
