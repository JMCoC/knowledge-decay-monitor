import { z } from "zod";

const versionId = z.string().uuid();

const noIntraListDuplicates = (list: string[]) =>
  new Set(list).size === list.length;

/**
 * Bounds mirror the contract §2.1 caps (1..20 sources, 0..20 comparisons).
 * Upper bounds live here; the S2-01 scope trigger owns the 20-version cap.
 * D4a rejects repeats inside one list; D4b allows the same id across lists.
 */
export const selectionSchema = z
  .object({
    sourceVersionIds: z
      .array(versionId)
      .min(1, "Select between 1 and 20 source documents.")
      .max(20, "Select between 1 and 20 source documents.")
      .refine(noIntraListDuplicates, {
        message: "Duplicates within the same list are not allowed.",
      }),
    comparisonVersionIds: z
      .array(versionId)
      .max(20, "Select up to 20 comparison documents.")
      .refine(noIntraListDuplicates, {
        message: "Duplicates within the same list are not allowed.",
      }),
  })
  .strict();

export type SelectionInput = z.infer<typeof selectionSchema>;
