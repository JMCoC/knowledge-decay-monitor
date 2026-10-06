import "server-only";

/**
 * Placeholder. Task 5 replaces the body with the real pipeline
 * (download canonical → parse → chunk → embed → finish_processing).
 * Never does the CAS; the Route Handler owns it.
 */
export async function runProcessing(versionId: string, operationId: string): Promise<void> {
  void versionId;
  void operationId;
}
