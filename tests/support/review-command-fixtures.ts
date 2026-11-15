import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { localSupabaseTarget } from "./local-supabase-target";
import { createReviewFixture, type ReviewFixture } from "./review-fixtures";

type ReviewService = SupabaseClient<Database>;

export interface ReviewCommandFixture extends ReviewFixture {
  readonly service: ReviewService;
  readonly verifiedAdminId: string;
  readonly candidateId: string;
  readonly candidateRoundId: string;
  readonly candidateSubmissionId: string;
  readonly candidateVersionId: string;
  readonly candidateStoragePath: string;
}

function createServiceClient() {
  const target = localSupabaseTarget();
  if (!target.disposableReview) throw new Error("Review command fixtures require the runner-owned project.");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error("The disposable review service credential is unavailable.");
  return createClient<Database>(target.apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

export async function createReviewCommandFixture(): Promise<ReviewCommandFixture> {
  const fixture = await createReviewFixture();
  const service = createServiceClient();
  let uploadedPath: string | undefined;
  let disposed = false;
  try {
    const { data: userData, error: userError } = await fixture.adminA.auth.getUser();
    const adminId = userData.user?.id;
    if (userError || !adminId) throw new Error("The synthetic reviewer session could not be verified.");
    const { data: profile, error: profileError } = await service.from("profiles")
      .select("id,workspace_id,role")
      .eq("id", adminId)
      .maybeSingle();
    if (profileError || !profile || profile.workspace_id !== fixture.workspaceA || profile.role !== "Admin") {
      throw new Error("The verified synthetic reviewer does not have the persisted Admin profile.");
    }

    const candidate = await fixture.prepareProcessingCandidate();
    const { data: version, error: versionError } = await service.from("document_versions")
      .select("storage_path")
      .eq("id", candidate.versionId)
      .maybeSingle();
    if (versionError || !version?.storage_path) throw new Error("The synthetic correction version has no storage path.");
    uploadedPath = version.storage_path;
    const upload = await service.storage.from("documents").upload(
      uploadedPath,
      new Blob(["# Synthetic correction candidate\n"], { type: "text/markdown" }),
      { contentType: "text/markdown", upsert: false },
    );
    if (upload.error) throw new Error("The synthetic correction file could not be installed in private Storage.");

    return {
      ...fixture,
      service,
      verifiedAdminId: adminId,
      candidateId: candidate.candidateId,
      candidateRoundId: candidate.roundId,
      candidateSubmissionId: candidate.submissionId,
      candidateVersionId: candidate.versionId,
      candidateStoragePath: uploadedPath,
      async dispose() {
        if (disposed) return;
        disposed = true;
        const removal = await service.storage.from("documents").remove([uploadedPath!]);
        if (removal.error) throw new Error("The synthetic correction file could not be removed from private Storage.");
        await fixture.dispose();
      },
    };
  } catch (error) {
    if (uploadedPath) await service.storage.from("documents").remove([uploadedPath]).catch(() => undefined);
    await fixture.dispose().catch(() => undefined);
    throw error instanceof Error ? error : new Error("The synthetic review command fixture could not be created.");
  }
}
