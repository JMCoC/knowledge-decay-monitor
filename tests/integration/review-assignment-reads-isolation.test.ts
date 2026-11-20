import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/types/database";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { localSupabaseTarget } from "../support/local-supabase-target";
import { createReviewFixture } from "../support/review-fixtures";

beforeAll(assertLocalSupabaseReady);

function createServiceClient() {
  const target = localSupabaseTarget();
  if (!target.disposableReview) throw new Error("Assignment read tests require the disposable review runner.");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("The disposable review service credential is unavailable.");
  return createClient<Database>(target.apiUrl, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null)) {
    throw new Error("The assignment read returned an invalid item list.");
  }
  return value as Record<string, unknown>[];
}

function signedUrlExpiry(signedUrl: string): number {
  const token = new URL(signedUrl).searchParams.get("token");
  if (!token) throw new Error("The local Storage signed URL did not contain its bearer token.");
  const payload = token.split(".")[1];
  if (!payload) throw new Error("The local Storage bearer token was not a JWT.");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
  if (typeof claims.exp !== "number") throw new Error("The local Storage bearer token had no expiry claim.");
  return claims.exp * 1000;
}

describe("Member assignment reads through local Auth, PostgREST, and Storage", () => {
  it("returns only persisted assignments, own coverage and minimal approval history", async () => {
    const fixture = await createReviewFixture();
    const service = createServiceClient();
    try {
      const targetFindingId = fixture.ids.findingsA.memberA[0]!;
      const crossDocumentId = await fixture.addCrossDocumentEvidenceForFinding(targetFindingId, 3);

      const page = await service.rpc("review_list_assignments", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 1,
        p_page_size: 100,
      });
      expect(page.error).toBeNull();
      const pagePayload = page.data as { items: unknown; total: number; page: number; pageSize: number };
      const assignments = rows(pagePayload.items);
      expect(pagePayload.page).toBe(1);
      expect(pagePayload.pageSize).toBe(100);
      const expectedAssignments = [
        ...fixture.ids.findingsA.memberA,
        ...fixture.ids.findingsA.additionalDocuments,
      ];
      expect(pagePayload.total).toBe(expectedAssignments.length);
      expect(assignments.map((item) => (item.finding as { id: string }).id).sort()).toEqual(
        expectedAssignments.sort(),
      );
      expect(JSON.stringify(page.data)).not.toMatch(/confidence|storage_path|storagePath|ledger|otherSubmissions/i);

      const firstPage = await service.rpc("review_list_assignments", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 1,
        p_page_size: 1,
      });
      const secondPage = await service.rpc("review_list_assignments", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 2,
        p_page_size: 1,
      });
      expect(firstPage.error).toBeNull();
      expect(secondPage.error).toBeNull();
      const firstPagePayload = firstPage.data as { items: unknown; total: number; page: number; pageSize: number };
      const secondPagePayload = secondPage.data as { items: unknown; total: number; page: number; pageSize: number };
      expect(firstPagePayload).toMatchObject({ total: expectedAssignments.length, page: 1, pageSize: 1 });
      expect(secondPagePayload).toMatchObject({ total: expectedAssignments.length, page: 2, pageSize: 1 });
      expect(rows(firstPagePayload.items)).toHaveLength(1);
      expect(rows(secondPagePayload.items)).toHaveLength(1);
      expect((rows(firstPagePayload.items)[0]?.finding as { id: string }).id)
        .not.toBe((rows(secondPagePayload.items)[0]?.finding as { id: string }).id);

      const filteredPage = await service.rpc("review_list_assignments", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 1,
        p_page_size: 100,
        p_status: "confirmed",
      });
      expect(filteredPage.error).toBeNull();
      expect((filteredPage.data as { total: number }).total).toBe(expectedAssignments.length);
      const filteredAssignments = rows((filteredPage.data as { items: unknown }).items);
      expect(filteredAssignments).toHaveLength(expectedAssignments.length);
      expect(filteredAssignments.every((item) =>
        (item.finding as { status: string }).status === "confirmed",
      )).toBe(true);

      const excludedStatus = await service.rpc("review_list_assignments", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 1,
        p_page_size: 100,
        p_status: "pending_review",
      });
      expect(excludedStatus.error).toBeNull();
      expect(excludedStatus.data).toMatchObject({ items: [], total: 0, page: 1, pageSize: 100 });

      const target = assignments.find((item) => (item.finding as { id: string }).id === targetFindingId);
      expect(target).toBeDefined();
      const documents = rows(target?.documents);
      expect(documents.map((item) => item.documentId)).toContain(crossDocumentId);
      expect(target?.evidence).toBeDefined();
      const rounds = rows(target?.rounds);
      expect(rounds.length).toBeGreaterThan(0);
      const coverage = rounds[0]?.ownCoverage as Record<string, unknown>;
      expect(coverage).toMatchObject({ complete: true, coveredItemCount: 3, requiredItemCount: 3 });
      expect(rounds[0]).not.toHaveProperty("otherMemberCount");
      const ownSubmissions = rows(target?.ownSubmissions);
      expect(ownSubmissions.length).toBeGreaterThan(0);
      expect(ownSubmissions.every((submission) =>
        (submission.submitter as { id: string }).id === fixture.userIds.memberA,
      )).toBe(true);

      const approvals = await service.rpc("review_list_own_approvals", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 1,
        p_page_size: 25,
      });
      expect(approvals.error).toBeNull();
      const approvalItems = rows((approvals.data as { items: unknown }).items);
      expect(approvalItems.length).toBeGreaterThan(0);
      expect(approvalItems.every((item) => Number(item.ownItemCount) > 0)).toBe(true);
      expect(JSON.stringify(approvals.data)).not.toMatch(/versionId|findingId|storage_path|private_reason/i);

      const otherMemberFinding = fixture.ids.findingsA.memberA2[0]!;
      const deniedDetail = await service.rpc("review_get_assignment", {
        p_actor_id: fixture.userIds.memberA,
        p_finding_id: otherMemberFinding,
      });
      expect(deniedDetail.data).toBeNull();
      expect(deniedDetail.error?.code).toBe("P0002");

      const reviewer = await fixture.adminA.auth.getUser();
      const reviewerId = reviewer.data.user?.id;
      expect(reviewer.error).toBeNull();
      expect(reviewerId).toBeTruthy();
      const adminList = await service.rpc("review_list_assignments", {
        p_actor_id: reviewerId!,
        p_page: 1,
        p_page_size: 25,
      });
      expect(adminList.data).toBeNull();
      expect(adminList.error?.code).toBe("42501");

      const sessionRpc = await fixture.memberA.rpc("review_get_assignment", {
        p_actor_id: fixture.userIds.memberA,
        p_finding_id: targetFindingId,
      });
      expect(sessionRpc.data).toBeNull();
      expect(sessionRpc.error?.code).toBe("42501");

      // Direct REST RLS may expose only the assigned finding/evidence rows,
      // never a neighboring assignment, full analysis or all chunks.
      const directAssignedFinding = await fixture.memberA.from("findings")
        .select("id,analysis_id,type,severity_original,severity_current,explanation,status,created_at,updated_at")
        .eq("id", targetFindingId);
      expect(directAssignedFinding.error).toBeNull();
      expect(directAssignedFinding.data?.map((item) => item.id)).toEqual([targetFindingId]);
      const directAssignedEvidence = await fixture.memberA.from("finding_evidence")
        .select("id").eq("finding_id", targetFindingId);
      expect(directAssignedEvidence.error).toBeNull();
      expect(directAssignedEvidence.data?.length).toBeGreaterThan(0);
      const memberA2FindingId = fixture.ids.findingsA.memberA2[0]!;
      const directNeighborFinding = await fixture.memberA.from("findings")
        .select("id").eq("id", memberA2FindingId);
      expect(directNeighborFinding.data ?? []).toEqual([]);
      const directNeighborEvidence = await fixture.memberA.from("finding_evidence")
        .select("id").eq("finding_id", memberA2FindingId);
      expect(directNeighborEvidence.data ?? []).toEqual([]);
      const directNeighborCount = await fixture.memberA.from("findings")
        .select("id", { count: "exact", head: true }).eq("id", memberA2FindingId);
      expect(directNeighborCount.error).toBeNull();
      expect(directNeighborCount.count).toBe(0);
      const directForeignFinding = await fixture.memberA.from("findings")
        .select("id").eq("id", fixture.ids.findingB);
      expect(directForeignFinding.data ?? []).toEqual([]);
      const directAnalysis = await fixture.memberA.from("analyses")
        .select("id").eq("id", (directAssignedFinding.data?.[0] as { analysis_id: string }).analysis_id);
      expect(directAnalysis.data ?? []).toEqual([]);
      const assignedChunkId = fixture.ids.versionsA.all[0]!;
      const directChunks = await fixture.memberA.from("document_chunks")
        .select("id").eq("version_id", assignedChunkId);
      expect(directChunks.data ?? []).toEqual([]);

      // Owner metadata and document visibility do not substitute for assignment.
      const ownerList = await service.rpc("review_list_assignments", {
        p_actor_id: fixture.userIds.documentOwnerA, p_page: 1, p_page_size: 25,
      });
      expect(ownerList.error).toBeNull();
      expect(rows((ownerList.data as { items: unknown }).items)).toEqual([]);
      const ownerDetail = await service.rpc("review_get_assignment", {
        p_actor_id: fixture.userIds.documentOwnerA, p_finding_id: targetFindingId,
      });
      expect(ownerDetail.data).toBeNull();
      expect(ownerDetail.error?.code).toBe("P0002");
      const targetActiveVersionId = rows(target?.documents)
        .find((document) => typeof document.activeVersionId === "string")?.activeVersionId;
      expect(targetActiveVersionId).toBeTruthy();
      const ownerOriginal = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.documentOwnerA,
        p_version_id: targetActiveVersionId as string,
      });
      expect(ownerOriginal.data).toBeNull();
      expect(ownerOriginal.error).toBeNull();

      const approvalDocumentId = approvalItems[0]?.documentId;
      expect(approvalDocumentId).toBeTruthy();
      const approvedDocumentFindings = assignments
        .filter((assignment) => rows(assignment.documents).some((document) =>
          document.documentId === approvalDocumentId,
        ))
        .map((assignment) => (assignment.finding as { id: string }).id);
      expect(approvedDocumentFindings).toHaveLength(3);

      for (const approvedFindingId of approvedDocumentFindings) {
        const current = await service.from("findings")
          .select("review_revision,status")
          .eq("id", approvedFindingId)
          .single();
        expect(current.error).toBeNull();
        expect(current.data?.status).toBe("confirmed");
        const reassignment = await service.rpc("review_assign_finding", {
          p_actor_id: reviewer.data.user!.id,
          p_finding_id: approvedFindingId,
          p_revision: current.data!.review_revision,
          p_assignee_id: fixture.userIds.memberA2,
          p_idempotency_key: `s3-07-approved-history-${randomUUID()}`,
        });
        expect(reassignment.error).toBeNull();
      }

      const approvalsAfterReassignment = await service.rpc("review_list_own_approvals", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 1,
        p_page_size: 25,
      });
      expect(approvalsAfterReassignment.error).toBeNull();
      expect(rows((approvalsAfterReassignment.data as { items: unknown }).items)).toEqual(approvalItems);
      expect(JSON.stringify(approvalsAfterReassignment.data))
        .not.toMatch(/versionId|findingId|storage_path|private_reason/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("opens only the assigned active original and revokes access after reassignment", async () => {
    const fixture = await createReviewFixture();
    const service = createServiceClient();
    try {
      const findingId = fixture.ids.findingsA.memberA[0]!;
      const details = await service.rpc("review_get_assignment", {
        p_actor_id: fixture.userIds.memberA,
        p_finding_id: findingId,
      });
      expect(details.error).toBeNull();
      const finding = details.data as { documents: { documentId: string; activeVersionId: string | null }[] };
      const relatedVersionId = finding.documents.find((document) => document.activeVersionId)?.activeVersionId;
      expect(relatedVersionId).toBeTruthy();
      const reviewer = await fixture.adminA.auth.getUser();
      expect(reviewer.error).toBeNull();
      expect(reviewer.data.user?.id).toBeTruthy();

      const versionId = relatedVersionId!;
      const storagePath = fixture.ids.storagePathsA.original;
      const attemptId = randomUUID();
      const idempotencyKey = randomUUID();
      const confirmedAt = new Date().toISOString();
      const bytes = Buffer.from("# Synthetic private review fixture\n", "utf8");
      const requestFingerprint = createHash("sha256").update(`s3-07:${versionId}`).digest("hex");
      const attempt = await service.from("document_upload_attempts").insert({
        id: attemptId,
        workspace_id: fixture.workspaceA,
        version_id: versionId,
        storage_path: storagePath.replace("/original.md", `/attempts/${attemptId}/original.md`),
        retired_at: confirmedAt,
        cleanup_status: "absent",
      });
      expect(attempt.error).toBeNull();
      const confirmed = await service.from("document_versions").update({
        upload_state: "confirmed",
        expected_sha256: createHash("sha256").update(bytes).digest("hex"),
        hash_source: "client_declared",
        upload_initiator_id: reviewer.data.user!.id,
        idempotency_key: idempotencyKey,
        request_fingerprint: requestFingerprint,
        current_upload_attempt_id: attemptId,
        upload_confirmed_at: confirmedAt,
        reference_set_at: confirmedAt,
        reference_set_by: reviewer.data.user!.id,
      }).eq("id", versionId);
      expect(confirmed.error).toBeNull();

      const adminPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: reviewer.data.user!.id,
        p_version_id: versionId,
      });
      expect(adminPath.error).toBeNull();
      expect(adminPath.data).toBe(storagePath);

      const memberPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: versionId,
      });
      expect(memberPath.error).toBeNull();
      expect(memberPath.data).toBe(storagePath);

      const directMemberDownload = await fixture.memberA.storage.from("documents").download(storagePath);
      expect(directMemberDownload.error).toBeTruthy();
      const otherMemberDownload = await fixture.memberA2.storage.from("documents").download(storagePath);
      expect(otherMemberDownload.error).toBeTruthy();
      const directMemberRpc = await fixture.memberA.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: versionId,
      });
      expect(directMemberRpc.data).toBeNull();
      expect(directMemberRpc.error?.code).toBe("42501");

      const signed = await service.storage.from("documents").createSignedUrl(memberPath.data!, 300);
      expect(signed.error).toBeNull();
      expect(signed.data?.signedUrl).toBeTruthy();
      const signedAt = Date.now();
      const expiresAt = signedUrlExpiry(signed.data!.signedUrl);
      expect(expiresAt).toBeGreaterThanOrEqual(signedAt + 299_000);
      expect(expiresAt).toBeLessThanOrEqual(signedAt + 301_000);
      const download = await fetch(signed.data!.signedUrl);
      expect(download.ok).toBe(true);
      expect(await download.text()).toContain("Synthetic private review fixture");

      expect(await fixture.readSubmissionState(fixture.ids.submissionsA.memberAGrouped)).toBe("confirmed");
      const ownCorrectionVersionId = await fixture.readSubmissionVersion(fixture.ids.submissionsA.memberAGrouped);
      const ownCorrectionVersion = await service.from("document_versions")
        .select("storage_path,upload_state,workflow_kind")
        .eq("id", ownCorrectionVersionId)
        .single();
      expect(ownCorrectionVersion.error).toBeNull();
      expect(ownCorrectionVersion.data).toMatchObject({
        upload_state: "confirmed",
        workflow_kind: "correction_submission",
      });
      const correctionPath = ownCorrectionVersion.data!.storage_path;
      const correctionBytes = Buffer.from("# Synthetic member correction\n", "utf8");
      const correctionUpload = await service.storage.from("documents").upload(
        correctionPath,
        new Blob([correctionBytes], { type: "text/markdown" }),
        { contentType: "text/markdown", upsert: false },
      );
      expect(correctionUpload.error).toBeNull();
      const ownCorrectionPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: ownCorrectionVersionId,
      });
      expect(ownCorrectionPath.error).toBeNull();
      expect(ownCorrectionPath.data).toBe(correctionPath);
      const correctionSigned = await service.storage.from("documents").createSignedUrl(correctionPath, 300);
      expect(correctionSigned.error).toBeNull();
      const correctionDownload = await fetch(correctionSigned.data!.signedUrl);
      expect(correctionDownload.ok).toBe(true);
      expect(await correctionDownload.text()).toContain("Synthetic member correction");

      const targetState = await service.from("findings")
        .select("review_revision,assignee_id")
        .eq("id", findingId)
        .single();
      expect(targetState.error).toBeNull();
      expect(targetState.data?.assignee_id).toBe(fixture.userIds.memberA);
      const unassign = await service.rpc("review_assign_finding", {
        p_actor_id: reviewer.data.user!.id,
        p_finding_id: findingId,
        p_revision: targetState.data!.review_revision,
        p_assignee_id: null as never,
        p_idempotency_key: `s3-07-unassign-${randomUUID()}`,
      });
      expect(unassign.error).toBeNull();
      const unassignedDetail = await service.rpc("review_get_assignment", {
        p_actor_id: fixture.userIds.memberA,
        p_finding_id: findingId,
      });
      expect(unassignedDetail.data).toBeNull();
      expect(unassignedDetail.error?.code).toBe("P0002");

      const unassignedVersionId = fixture.ids.versionsA.all.find((candidate) => candidate !== versionId);
      expect(unassignedVersionId).toBeTruthy();
      const unrelatedPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: unassignedVersionId!,
      });
      expect(unrelatedPath.error).toBeNull();
      expect(unrelatedPath.data).toBeNull();

      const foreignVersion = await service.from("document_versions")
        .select("id,storage_path")
        .eq("workspace_id", fixture.workspaceB)
        .limit(1)
        .single();
      expect(foreignVersion.error).toBeNull();
      const deniedPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: foreignVersion.data!.id,
      });
      expect(deniedPath.data).toBeNull();
      expect(deniedPath.error).toBeNull();
      const foreignOriginalDownload = await fixture.memberA.storage.from("documents")
        .download(foreignVersion.data!.storage_path);
      expect(foreignOriginalDownload.error).toBeTruthy();

      const memberPage = await service.rpc("review_list_assignments", {
        p_actor_id: fixture.userIds.memberA,
        p_page: 1,
        p_page_size: 100,
      });
      expect(memberPage.error).toBeNull();
      const memberAssignments = rows((memberPage.data as { items: unknown }).items);
      const relatedFindingIds = memberAssignments
        .filter((assignment) => rows(assignment.documents).some((document) =>
          document.documentId === finding.documents.find((item) => item.activeVersionId === versionId)?.documentId,
        ))
        .map((assignment) => (assignment.finding as { id: string }).id);
      expect(relatedFindingIds).not.toContain(findingId);
      // A shared document remains open while another active finding on that
      // document is still assigned to this Member. Revoke those assignments
      // too, then verify the final document-level capability disappears.
      for (const relatedFindingId of relatedFindingIds) {
        if (relatedFindingId === findingId) continue;
        const current = await service.from("findings")
          .select("review_revision,status")
          .eq("id", relatedFindingId)
          .single();
        expect(current.error).toBeNull();
        if (current.data?.status === "pending_review") {
          const closed = await service.rpc("review_change_finding", {
            p_actor_id: reviewer.data.user!.id,
            p_finding_id: relatedFindingId,
            p_revision: current.data.review_revision,
            p_change: { field: "status", value: "false_positive" },
            p_idempotency_key: `s3-07-close-${randomUUID()}`,
          });
          expect(closed.error).toBeNull();
        } else {
          expect(["confirmed", "update_planned"]).toContain(current.data?.status);
          const reassignment = await service.rpc("review_assign_finding", {
            p_actor_id: reviewer.data.user!.id,
            p_finding_id: relatedFindingId,
            p_revision: current.data!.review_revision,
            p_assignee_id: fixture.userIds.memberA2,
            p_idempotency_key: `s3-07-reassign-${randomUUID()}`,
          });
          expect(reassignment.error).toBeNull();
        }
      }

      const revoked = await service.rpc("review_get_assignment", {
        p_actor_id: fixture.userIds.memberA,
        p_finding_id: findingId,
      });
      expect(revoked.data).toBeNull();
      expect(revoked.error?.code).toBe("P0002");

      const revokedPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: versionId,
      });
      expect(revokedPath.error).toBeNull();
      expect(revokedPath.data).toBeNull();

      const revokedCorrectionPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: ownCorrectionVersionId,
      });
      expect(revokedCorrectionPath.error).toBeNull();
      expect(revokedCorrectionPath.data).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps the exact historical evidence snapshot visible without resolving its original", async () => {
    const fixture = await createReviewFixture();
    const service = createServiceClient();
    try {
      const findingId = fixture.ids.findingsA.additionalDocuments[0]!;
      const sourceVersionId = fixture.ids.versionsA.all[1]!;
      const detail = await service.rpc("review_get_assignment", {
        p_actor_id: fixture.userIds.memberA,
        p_finding_id: findingId,
      });
      expect(detail.error).toBeNull();
      const snapshot = detail.data as {
        evidence: { documentId: string; versionId: string; versionNumber: number; snapshot: string }[];
        documents: { documentId: string; activeVersionId: string | null }[];
      };
      const historicalEvidence = snapshot.evidence.find((item) => item.versionId === sourceVersionId);
      expect(historicalEvidence).toMatchObject({
        versionId: sourceVersionId,
        versionNumber: 1,
        snapshot: "Synthetic evidence for document two finding one",
      });
      const relatedDocument = snapshot.documents.find((item) => item.documentId === historicalEvidence?.documentId);
      expect(relatedDocument?.activeVersionId).toBeTruthy();
      expect(relatedDocument?.activeVersionId).not.toBe(sourceVersionId);

      const historicalVersion = await service.from("document_versions")
        .select("storage_path,upload_state,version_status")
        .eq("id", sourceVersionId)
        .single();
      expect(historicalVersion.error).toBeNull();
      expect(historicalVersion.data?.version_status).toBe("historical");
      const uploader = await fixture.adminA.auth.getUser();
      expect(uploader.error).toBeNull();
      const attemptId = randomUUID();
      const confirmedAt = new Date().toISOString();
      const bytes = Buffer.from("Synthetic historical original metadata", "utf8");
      const attempt = await service.from("document_upload_attempts").insert({
        id: attemptId,
        workspace_id: fixture.workspaceA,
        version_id: sourceVersionId,
        storage_path: historicalVersion.data!.storage_path.replace(
          "/original.md",
          `/attempts/${attemptId}/original.md`,
        ),
        retired_at: confirmedAt,
        cleanup_status: "absent",
      });
      expect(attempt.error).toBeNull();
      const confirmation = await service.from("document_versions").update({
        upload_state: "confirmed",
        expected_sha256: createHash("sha256").update(bytes).digest("hex"),
        hash_source: "client_declared",
        upload_initiator_id: uploader.data.user!.id,
        idempotency_key: randomUUID(),
        request_fingerprint: createHash("sha256").update(`historical:${sourceVersionId}`).digest("hex"),
        current_upload_attempt_id: attemptId,
        upload_confirmed_at: confirmedAt,
        reference_set_at: confirmedAt,
        reference_set_by: uploader.data.user!.id,
      }).eq("id", sourceVersionId);
      expect(confirmation.error).toBeNull();

      const reviewerPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: uploader.data.user!.id,
        p_version_id: sourceVersionId,
      });
      expect(reviewerPath.error).toBeNull();
      expect(reviewerPath.data).toBe(historicalVersion.data!.storage_path);
      const memberPath = await service.rpc("get_review_workflow_document_path", {
        p_user_id: fixture.userIds.memberA,
        p_version_id: sourceVersionId,
      });
      expect(memberPath.error).toBeNull();
      expect(memberPath.data).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });
});
