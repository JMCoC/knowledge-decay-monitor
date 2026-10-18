import { z } from "zod";
import type { DocumentCategory } from "@/types/contracts";

const versionId = z.string().uuid();
const documentCategories = [
  "SOP",
  "Policy",
  "Manual",
  "QA Process",
  "Security",
  "Engineering Guideline",
  "Other",
] as const satisfies readonly [DocumentCategory, ...DocumentCategory[]];

export const eligibleDocumentsQuerySchema = z.object({
  name: z.string().max(200).trim().optional(),
  category: z.enum(documentCategories).optional(),
  ownerId: z.union([z.string().uuid(), z.null()]).optional(),
  page: z.coerce.number().int().min(1, "Page must be at least 1.").default(1),
  pageSize: z.coerce.number().int().min(1).max(100, "Page size cannot exceed 100.").default(25),
});

export const analysisSelectionInputSchema = z.object({
  sourceVersionIds: z.array(versionId)
    .min(1, "At least one source document is required.")
    .max(20, "No more than 20 source documents can be selected."),
  comparisonVersionIds: z.array(versionId).max(20, "No more than 20 comparison documents can be selected.").default([]),
});

const idempotencyKey = z.string()
  .min(1, "An idempotency key is required.")
  .max(128, "The idempotency key cannot exceed 128 characters.")
  .refine((value) => value === value.trim(), "The idempotency key cannot start or end with whitespace.");

export const runAnalysisInputSchema = z.object({
  estimateRef: versionId,
  idempotencyKey,
}).strict();

export const retryAnalysisInputSchema = z.object({
  estimateRef: versionId,
  idempotencyKey,
  failedAnalysisId: versionId,
}).strict();

export const resolveFilteredScopeSchema = z.object({
  query: eligibleDocumentsQuerySchema.default({ page: 1, pageSize: 25 }),
  targetRole: z.enum(["source", "comparison"]),
  currentSourceVersionIds: z.array(versionId).max(20).default([]),
  currentComparisonVersionIds: z.array(versionId).max(20).default([]),
});

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
      .min(1, "At least one source document is required.")
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
