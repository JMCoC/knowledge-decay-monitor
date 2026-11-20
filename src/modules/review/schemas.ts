import { z } from "zod";

const uuid = z.string().uuid().toLowerCase();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = z.string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());

function uniqueIds(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

const uniqueFindingIds = z.array(uuid)
  .min(1)
  .max(100)
  .refine(uniqueIds)
  .transform((ids) => [...ids].sort());

export const changeFindingSchema = z.strictObject({
  findingId: uuid,
  revision,
  idempotencyKey,
  change: z.discriminatedUnion("field", [
    z.strictObject({
      field: z.literal("status"),
      value: z.enum(["pending_review", "confirmed", "false_positive", "update_planned", "resolved"]),
    }),
    z.strictObject({ field: z.literal("severity"), value: z.enum(["High", "Medium", "Low"]) }),
  ]),
});

export const assignFindingSchema = z.strictObject({
  findingId: uuid,
  revision,
  assigneeId: uuid.nullable(),
  idempotencyKey,
});

export const prepareRoundSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    documentId: uuid,
    mode: z.literal("assigned_findings"),
    findingIds: uniqueFindingIds,
    idempotencyKey,
  }),
  z.strictObject({
    documentId: uuid,
    mode: z.literal("administrative"),
    idempotencyKey,
  }),
]);

export const updateRoundDraftSchema = z.strictObject({
  roundId: uuid,
  revision,
  findingIds: uniqueFindingIds,
  idempotencyKey,
});

export const openRoundSchema = z.strictObject({ roundId: uuid, revision, idempotencyKey });

export const cancelRoundSchema = z.strictObject({
  roundId: uuid,
  revision,
  reason: z.string().trim().min(1).max(2000),
  idempotencyKey,
});

export const reviewPageSchema = z.strictObject({
  page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().positive().max(100).default(25),
});

export const listAssignmentsSchema = reviewPageSchema.extend({
  status: z.enum([
    "pending_review", "confirmed", "update_planned",
  ]).optional(),
});

export const getAssignmentSchema = uuid;
export const listOwnApprovalsSchema = reviewPageSchema;

export const getFindingReviewSchema = z.strictObject({ findingId: uuid });
export const getRoundDraftSchema = z.strictObject({ roundId: uuid });
