import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type ProcessingRetryClaim = { kind: "queued" | "not_found" | "conflict" };

/** Caller must derive workspaceId from requireDocumentActor, never browser input. */
export async function claimProcessingRetry(input: { workspaceId: string; versionId: string }): Promise<ProcessingRetryClaim> {
  const { data, error } = await createServiceClient().rpc("enqueue_ingestion_job", {
    p_workspace_id: input.workspaceId, p_version_id: input.versionId, p_retry: true,
  }).abortSignal(AbortSignal.timeout(5_000));
  if (error || !["queued", "not_found", "conflict"].includes(data ?? "")) throw new Error("Retry could not be queued.");
  return { kind: data as ProcessingRetryClaim["kind"] };
}
