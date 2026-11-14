import { beforeAll, describe, expect, it } from "vitest";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { createReviewFixture } from "../support/review-fixtures";

async function expectDenied(request: PromiseLike<{ data: unknown; error: { code?: string } | null }>) {
  const { data, error } = await request;
  expect(data).toBeNull();
  expect(error?.code).toBe("42501");
}

beforeAll(assertLocalSupabaseReady);

describe("review isolation through local Auth and PostgREST", () => {
  it("limits findings, submissions, and versions to the persisted review assignment", async () => {
    const fixture = await createReviewFixture();
    try {
      const allWorkspaceAFindingIds = [
        ...fixture.ids.findingsA.memberA,
        ...fixture.ids.findingsA.memberA2,
        ...fixture.ids.findingsA.unassigned,
      ];

      const memberAFindings = await fixture.memberA.from("findings")
        .select("id,assignee_id,review_revision")
        .in("id", allWorkspaceAFindingIds);
      expect(memberAFindings.error).toBeNull();
      expect(memberAFindings.data?.map((finding) => finding.id).sort()).toEqual(
        [...fixture.ids.findingsA.memberA].sort(),
      );
      expect(memberAFindings.data?.every((finding) => finding.assignee_id === fixture.userIds.memberA)).toBe(true);

      const memberA2Findings = await fixture.memberA2.from("findings")
        .select("id,assignee_id,review_revision")
        .in("id", allWorkspaceAFindingIds);
      expect(memberA2Findings.error).toBeNull();
      expect(memberA2Findings.data?.map((finding) => finding.id).sort()).toEqual(
        [...fixture.ids.findingsA.memberA2].sort(),
      );

      const adminFindings = await fixture.adminA.from("findings").select("id")
        .in("id", allWorkspaceAFindingIds);
      expect(adminFindings.error).toBeNull();
      expect(adminFindings.data).toHaveLength(allWorkspaceAFindingIds.length);
      const qaFindings = await fixture.qaA.from("findings").select("id")
        .in("id", allWorkspaceAFindingIds);
      expect(qaFindings.error).toBeNull();
      expect(qaFindings.data).toHaveLength(allWorkspaceAFindingIds.length);

      const unassignedOwnerFindings = await fixture.documentOwnerA.from("findings")
        .select("id")
        .in("id", allWorkspaceAFindingIds);
      expect(unassignedOwnerFindings).toMatchObject({ data: [], error: null });

      const ownEvidence = await fixture.memberA.from("finding_evidence")
        .select("id,finding_id,chunk_id,snapshot")
        .in("finding_id", fixture.ids.findingsA.memberA);
      expect(ownEvidence.error).toBeNull();
      expect(ownEvidence.data).toHaveLength(fixture.ids.findingsA.memberA.length);
      expect(ownEvidence.data?.every((evidence) => fixture.ids.findingsA.memberA.includes(evidence.finding_id))).toBe(true);

      const ownItems = await fixture.memberA.from("correction_round_items")
        .select("id,round_id,finding_id,assignee_id,revision,current_submission_id,created_at")
        .in("id", fixture.ids.roundItemsA.all);
      expect(ownItems.error).toBeNull();
      expect(ownItems.data?.map((item) => item.id).sort()).toEqual(
        [...fixture.ids.roundItemsA.memberA].sort(),
      );
      expect(ownItems.data?.every((item) => item.current_submission_id === fixture.ids.submissionsA.memberAGrouped)).toBe(true);

      const ownSubmissions = await fixture.memberA.from("correction_submissions")
        .select("id,round_id,submitter_id,state,reserved_at,expires_at,confirmed_at,created_at")
        .in("id", fixture.ids.submissionsA.all);
      expect(ownSubmissions.error).toBeNull();
      expect(ownSubmissions.data?.map((submission) => submission.id).sort()).toEqual(
        [fixture.ids.submissionsA.memberAGrouped].sort(),
      );
      expect(ownSubmissions.data?.[0]?.state).toBe("confirmed");

      const otherMemberSubmission = await fixture.memberA2.from("correction_submissions")
        .select("id,submitter_id,state")
        .in("id", fixture.ids.submissionsA.all);
      expect(otherMemberSubmission.error).toBeNull();
      expect(otherMemberSubmission.data?.map((submission) => submission.id)).toEqual([
        fixture.ids.submissionsA.memberA2Confirmed,
      ]);

      const reservedSubmission = await fixture.memberA.from("correction_submissions")
        .select("id,state")
        .eq("id", fixture.ids.submissionsA.reserved);
      expect(reservedSubmission.error).toBeNull();
      expect(reservedSubmission.data).toEqual([{ id: fixture.ids.submissionsA.reserved, state: "reserved" }]);
      const expiredSubmission = await fixture.memberA.from("correction_submissions")
        .select("id,state")
        .eq("id", fixture.ids.submissionsA.expired);
      expect(expiredSubmission).toMatchObject({ data: [], error: null });

      const candidateHistory = await fixture.adminA.from("correction_candidates")
        .select("id,status,selection_kind")
        .in("id", [fixture.ids.candidatesA.approved, fixture.ids.candidatesA.rejected, fixture.ids.candidatesA.invalidated]);
      expect(candidateHistory.error).toBeNull();
      expect(candidateHistory.data?.map(({ id, status, selection_kind }) => ({ id, status, selection_kind })))
        .toEqual(expect.arrayContaining([
          { id: fixture.ids.candidatesA.approved, status: "approved", selection_kind: "consolidated" },
          { id: fixture.ids.candidatesA.rejected, status: "rejected", selection_kind: "direct" },
          { id: fixture.ids.candidatesA.invalidated, status: "invalidated", selection_kind: "consolidated" },
        ]));
      const returnedRoundItems = await fixture.adminA.from("correction_round_items")
        .select("finding_id,current_submission_id,revision")
        .eq("round_id", fixture.ids.partialReturnA.roundId);
      expect(returnedRoundItems.error).toBeNull();
      expect(returnedRoundItems.data?.filter((item) => item.current_submission_id !== null)).toHaveLength(2);
      expect(returnedRoundItems.data?.map((item) => item.current_submission_id).filter((id): id is string => id !== null).sort())
        .toEqual([...fixture.ids.partialReturnA.preservedSubmissions].sort());
      expect(returnedRoundItems.data?.filter((item) => item.current_submission_id === null))
        .toEqual([expect.objectContaining({ revision: fixture.ids.partialReturnA.returnedRevision })]);
      const emptyAdministrativeRound = await fixture.adminA.from("correction_round_items")
        .select("id").eq("round_id", fixture.ids.roundsA.administrative);
      expect(emptyAdministrativeRound).toMatchObject({ data: [], error: null });

      const workspaceBRows = await fixture.adminA.from("findings").select("id")
        .eq("id", fixture.ids.findingB);
      expect(workspaceBRows).toMatchObject({ data: [], error: null });
      const workspaceAFromB = await fixture.adminB.from("findings").select("id")
        .in("id", allWorkspaceAFindingIds);
      expect(workspaceAFromB).toMatchObject({ data: [], error: null });
      const adminBRows = await fixture.adminB.from("findings").select("id")
        .eq("id", fixture.ids.findingB);
      expect(adminBRows).toMatchObject({ data: [{ id: fixture.ids.findingB }], error: null });
      const memberBWorkspaceA = await fixture.memberB.from("findings").select("id")
        .in("id", allWorkspaceAFindingIds);
      expect(memberBWorkspaceA).toMatchObject({ data: [], error: null });

      await expectDenied(fixture.memberA.from("findings").update({ status: "resolved" })
        .eq("id", fixture.ids.findingsA.memberA[0]));
      await expectDenied(fixture.memberA.from("correction_round_items").update({ assignee_id: fixture.userIds.memberA2 })
        .eq("id", fixture.ids.roundItemsA.memberA[0]));
      await expectDenied(fixture.memberA.from("correction_submissions").update({ state: "invalidated" })
        .eq("id", fixture.ids.submissionsA.memberAGrouped));
      await expectDenied(fixture.memberA.from("document_versions").select("id,storage_path")
        .eq("id", fixture.ids.versionsA.base));
      await expectDenied(fixture.memberA.from("correction_submissions").select("version_id")
        .eq("id", fixture.ids.submissionsA.memberAGrouped));

      const privateOriginal = await fixture.memberA.storage.from("documents")
        .download(fixture.ids.storagePathsA.original);
      expect(privateOriginal.error).toBeTruthy();
    } finally {
      await fixture.dispose();
    }
  });
});
