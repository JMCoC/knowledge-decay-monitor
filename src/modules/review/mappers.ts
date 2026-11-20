import "server-only";

import { z, type ZodTypeAny } from "zod";
import type {
  CorrectionRoundSnapshot,
  FindingReviewSnapshot,
  MemberAssignment,
  OwnApprovalItem,
  ReviewPage,
  ReviewRound,
  RoundDraftSnapshot,
} from "@/types/review-contracts";
import type { EligibleOwner, FindingEvidenceItem } from "@/types/contracts";

const uuid = z.string().uuid();
const timestamp = z.string().min(1);
const ownerSchema = z.object({ id: uuid, fullName: z.string().min(1) });
const findingStatus = z.enum([
  "pending_review", "confirmed", "false_positive", "update_planned", "resolved",
]);
const roundStatus = z.enum([
  "draft", "collecting", "consolidating", "candidate_processing", "candidate_failed",
  "pending_approval", "approved", "cancelled",
]);

const findingReviewSchema = z.object({
  id: uuid,
  analysisId: uuid,
  type: z.enum(["contradiction", "obsolescence"]),
  explanation: z.string().min(1),
  severityOriginal: z.enum(["High", "Medium", "Low"]),
  severityCurrent: z.enum(["High", "Medium", "Low"]),
  status: findingStatus,
  assignee: ownerSchema.nullable(),
  createdAt: timestamp,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  canChangeStatus: z.boolean(),
  canChangeSeverity: z.boolean(),
  canAssign: z.boolean(),
  canPrepareRound: z.boolean(),
});

const roundSnapshotSchema = z.object({
  roundId: uuid,
  documentId: uuid,
  mode: z.enum(["assigned_findings", "administrative"]),
  baseActiveVersionId: uuid,
  status: roundStatus,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: timestamp,
  openedAt: timestamp.nullable(),
});

const roundDraftSchema = roundSnapshotSchema.extend({ findingIds: z.array(uuid) });

const uploadSnapshotSchema = z.object({
  versionId: uuid,
  uploadState: z.enum(["pending", "verifying", "rejected", "recovering", "confirmed"]).nullable(),
  attemptId: uuid.nullable(),
  canOpen: z.boolean(),
  canResume: z.boolean(),
  canRecover: z.boolean(),
});

const submissionSchema = z.object({
  submissionId: uuid,
  versionId: uuid,
  state: z.enum(["reserved", "confirmed", "expired", "invalidated"]),
  submitter: ownerSchema,
  itemIds: z.array(uuid),
  upload: uploadSnapshotSchema,
  confirmedAt: timestamp.nullable(),
});

const candidateSchema = z.object({
  candidateId: uuid,
  versionId: uuid,
  selectionKind: z.enum(["direct", "consolidated"]),
  status: z.enum(["reserved", "selected", "processing", "failed", "pending_approval", "approved", "rejected", "invalidated"]),
  processingStatus: z.enum(["uploaded", "processing", "ready", "processing_failed"]),
  versionStatus: z.enum(["active", "historical", "rejected", "pending_approval"]).nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  coverageRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  itemIds: z.array(uuid),
});

const roundItemSchema = z.object({
  itemId: uuid,
  finding: findingReviewSchema,
  initialAssignee: ownerSchema.nullable(),
  assignee: ownerSchema.nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currentSubmissionId: uuid.nullable(),
});

const roundCoverageSchema = z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  complete: z.boolean(),
  coveredItemCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requiredItemCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const reviewRoundSchema = roundSnapshotSchema.extend({
  items: z.array(roundItemSchema),
  submissions: z.array(submissionSchema),
  coverage: roundCoverageSchema,
  candidate: candidateSchema.nullable(),
});

const evidenceSchema: z.ZodType<FindingEvidenceItem> = z.object({
  id: uuid,
  documentId: uuid,
  documentName: z.string().min(1),
  versionId: uuid,
  versionNumber: z.number().int().positive(),
  chunkId: uuid,
  pageNumber: z.number().int().positive().nullable(),
  section: z.string().nullable(),
  sectionHeading: z.string().nullable(),
  snapshot: z.string().min(1),
});

const memberAssignmentSchema: z.ZodType<MemberAssignment> = z.object({
  finding: findingReviewSchema,
  evidence: z.array(evidenceSchema),
  documents: z.array(z.object({
    documentId: uuid,
    name: z.string().min(1),
    activeVersionId: uuid.nullable(),
    activeVersionNumber: z.number().int().positive().nullable(),
    canSubmit: z.boolean(),
  })),
  rounds: z.array(z.object({
    roundId: uuid,
    documentId: uuid,
    phase: z.enum(["waiting", "consolidating", "processing", "processing_failed", "review", "approved"]),
    ownCoverage: z.object({
      complete: z.boolean(),
      coveredItemCount: z.number().int().nonnegative(),
      requiredItemCount: z.number().int().nonnegative(),
    }),
  })),
  ownSubmissions: z.array(submissionSchema),
  returns: z.array(z.object({ itemId: uuid, reason: z.string(), createdAt: timestamp })),
});

const ownApprovalSchema: z.ZodType<OwnApprovalItem> = z.object({
  approvalId: uuid,
  documentId: uuid,
  approvedAt: timestamp,
  ownItemCount: z.number().int().positive(),
});

const assigneesPageSchema = z.object({
  items: z.array(ownerSchema),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pageSize: z.number().int().positive().max(100),
});

class ReviewProjectionError extends Error {
  constructor() {
    super("The review projection is invalid.");
    this.name = "ReviewProjectionError";
  }
}

function parseProjection<TSchema extends ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ReviewProjectionError();
  return parsed.data;
}

export function parseFindingReviewSnapshot(value: unknown): FindingReviewSnapshot {
  return parseProjection(findingReviewSchema, value);
}

export function parseCorrectionRoundSnapshot(value: unknown): CorrectionRoundSnapshot {
  return parseProjection(roundSnapshotSchema, value);
}

export function parseRoundDraftSnapshot(value: unknown): RoundDraftSnapshot {
  return parseProjection(roundDraftSchema, value);
}

export function parseReviewRound(value: unknown): ReviewRound {
  return parseProjection(reviewRoundSchema, value);
}

export function parseAssigneesPage(value: unknown): ReviewPage<EligibleOwner> {
  return parseProjection(assigneesPageSchema, value);
}

export function parseMemberAssignmentsPage(value: unknown): ReviewPage<MemberAssignment> {
  return parseProjection(z.object({
    items: z.array(memberAssignmentSchema),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    pageSize: z.number().int().positive().max(100),
  }), value);
}

export function parseMemberAssignment(value: unknown): MemberAssignment {
  return parseProjection(memberAssignmentSchema, value);
}

export function parseOwnApprovalsPage(value: unknown): ReviewPage<OwnApprovalItem> {
  return parseProjection(z.object({
    items: z.array(ownApprovalSchema),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    pageSize: z.number().int().positive().max(100),
  }), value);
}
