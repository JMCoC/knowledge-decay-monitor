/**
 * The pipeline entry point. S1-03 has no worker, so this is a no-op that
 * returns the status the reservation already set. S1-04 replaces the body and
 * changes the return to "processing"; `actions.ts` does not change with it.
 *
 * Narrower than ProcessingStatus on purpose: these are the only two statuses
 * the FinalizeItemResult contract admits.
 */
export async function startProcessing(
  _versionId: string,
  _supabase: unknown,
): Promise<"uploaded" | "processing"> {
  return "uploaded";
}
