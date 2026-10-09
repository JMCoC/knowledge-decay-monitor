import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

export const PROCESSING_LEASE_MS = 180_000;

export type ProcessingRetryClaim =
  | { kind: "claimed"; operationId: string }
  | { kind: "not_found" }
  | { kind: "conflict" };

/** Atomically claims an uploaded v1, failed version, or expired processing lease. */
export async function claimProcessingRetry(input: {
  workspaceId: string;
  versionId: string;
  operationId: string;
  now?: Date;
}): Promise<ProcessingRetryClaim> {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS).toISOString();
  const service = createServiceClient();
  const { data: version, error: readError } = await service
    .from("document_versions")
    .select("id, workspace_id, version_number, upload_state, processing_status, processing_operation_id, processing_started_at, version_status")
    .eq("id", input.versionId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (readError) throw new Error("Retry state lookup failed.");
  if (!version) return { kind: "not_found" };
  if (
    version.version_number !== 1 ||
    version.upload_state !== "confirmed" ||
    version.version_status !== null
  ) {
    return { kind: "conflict" };
  }

  const uploaded = version.processing_status === "uploaded";
  const failed = version.processing_status === "processing_failed";
  const staleProcessing =
    version.processing_status === "processing" &&
    typeof version.processing_operation_id === "string" &&
    typeof version.processing_started_at === "string" &&
    Number.isFinite(Date.parse(version.processing_started_at)) &&
    Date.parse(version.processing_started_at) < Date.parse(staleBefore);
  if (!uploaded && !failed && !staleProcessing) return { kind: "conflict" };

  let claim = service
    .from("document_versions")
    .update({
      processing_status: "processing",
      processing_operation_id: input.operationId,
      processing_started_at: now.toISOString(),
    })
    .eq("id", input.versionId)
    .eq("workspace_id", input.workspaceId)
    .eq("version_number", 1)
    .eq("upload_state", "confirmed")
    .is("version_status", null)
    .eq("processing_status", version.processing_status);

  if (staleProcessing) {
    claim = claim
      .eq("processing_operation_id", version.processing_operation_id!)
      .lt("processing_started_at", staleBefore);
  }

  const { data, error } = await claim.select("processing_operation_id");
  if (error) throw new Error("Retry could not be claimed.");
  if (!data?.some((row) => row.processing_operation_id === input.operationId)) {
    return { kind: "conflict" };
  }
  return { kind: "claimed", operationId: input.operationId };
}
