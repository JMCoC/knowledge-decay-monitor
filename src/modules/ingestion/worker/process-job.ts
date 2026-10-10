import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { chunkDeterministic, parseDocument, ParseError } from "../chunking";
import { downloadStorageObject } from "../storage";
import type { AllowedExtension } from "../validation";
import { embedTexts, type Infer } from "./embeddings";

export type IngestionJob = Database["public"]["Functions"]["claim_ingestion_job"]["Returns"][number];
export type JobOutcome = "completed" | "queued" | "failed" | "superseded" | "uncertain";

/** No provider errors or document contents escape this boundary. */
export async function processJob(
  job: IngestionJob,
  service: SupabaseClient<Database>,
  infer: Infer,
  signal: AbortSignal,
): Promise<JobOutcome> {
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    signal.throwIfAborted();
    const row = await service.from("document_versions")
      .select("id,workspace_id,document_id,storage_path,upload_state,processing_status,processing_operation_id")
      .eq("id", job.version_id).eq("workspace_id", job.workspace_id).abortSignal(requestSignal()).single();
    if (row.error || !row.data) throw new Error("PERSISTENCE_FAILED");
    const version = row.data;
    if (version.upload_state !== "confirmed" || version.processing_status !== "processing"
      || version.processing_operation_id !== job.operation_id) return "superseded";
    const match = version.storage_path.match(/\/original\.(pdf|docx|md)$/);
    if (!match || !version.storage_path.startsWith(`${job.workspace_id}/${version.document_id}/${job.version_id}/`)) {
      throw new Error("PERSISTENCE_FAILED");
    }
    const response = await downloadStorageObject(version.storage_path, requestSignal());
    if (!response) throw new Error("PERSISTENCE_FAILED");
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    const { sections } = await parseDocument(bytes, match[1] as AllowedExtension);
    signal.throwIfAborted();
    const drafts = chunkDeterministic(sections, { targetTokens: 450, overlapTokens: 50 });
    const embeddings = await embedTexts(drafts.map((d) => d.text_content), infer, signal);
    signal.throwIfAborted();
    const chunks = drafts.map((draft, index) => ({ ...draft, embedding: embeddings[index] }));
    let completionFailed = false;
    try {
      const result = await service.rpc("finish_processing", {
        p_version_id: job.version_id, p_operation_id: job.operation_id, p_chunks: chunks,
      }).abortSignal(requestSignal());
      completionFailed = Boolean(result.error);
    } catch { completionFailed = true; }
    if (!completionFailed) return "completed";
    // A missing HTTP response is not proof the SQL transaction failed.
    const current = await service.from("document_versions").select("processing_status,version_status,processing_operation_id")
      .eq("id", job.version_id).eq("workspace_id", job.workspace_id).abortSignal(requestSignal()).maybeSingle();
    if (current.error || !current.data) return "uncertain";
    if (current.data.processing_status === "ready" && current.data.version_status === "active") {
      const document = await service.from("documents").select("active_version_id")
        .eq("id", version.document_id).eq("workspace_id", job.workspace_id).abortSignal(requestSignal()).single();
      return !document.error && document.data?.active_version_id === job.version_id ? "completed" : "uncertain";
    }
    if (current.data.processing_operation_id !== job.operation_id) return "superseded";
    throw new Error("PERSISTENCE_FAILED");
  } catch (error) {
    // Lost lease/shutdown: never mark a newer worker's version failed. DB will redeliver.
    if (signal.aborted) return "superseded";
    const result = await service.rpc("fail_ingestion_job", {
      p_version_id: job.version_id, p_operation_id: job.operation_id,
      p_retryable: !(error instanceof ParseError),
    }).abortSignal(AbortSignal.timeout(5_000)).then((r) => r, () => null);
    if (!result || result.error) return "uncertain";
    return ["queued", "failed", "superseded"].includes(result.data) ? result.data as JobOutcome : "uncertain";
  }
}
