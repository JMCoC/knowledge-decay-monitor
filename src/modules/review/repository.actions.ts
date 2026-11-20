"use server";

import "server-only";

import { requireActor } from "@/modules/identity";
import { createServiceClient } from "@/lib/supabase/service";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import type { ActionResult } from "@/types/contracts";
import type {
  ListAssignmentsInput,
  ListOwnApprovalsInput,
  MemberAssignment,
  OwnApprovalItem,
  ReviewPage,
} from "@/types/review-contracts";
import {
  getAssignmentSchema,
  listAssignmentsSchema,
  listOwnApprovalsSchema,
} from "./schemas";
import { toReviewFailure } from "./errors";
import {
  parseMemberAssignment,
  parseMemberAssignmentsPage,
  parseOwnApprovalsPage,
} from "./mappers";

function invalidInput<T>(): ActionResult<T> {
  return { ok: false, error: { code: "INVALID_INPUT", message: "Some review details are invalid." } };
}

export async function listAssignments(
  input: ListAssignmentsInput = {},
): Promise<ActionResult<ReviewPage<MemberAssignment>>> {
  const parsed = listAssignmentsSchema.safeParse(input);
  if (!parsed.success) return invalidInput();

  try {
    const actor = await requireActor();
    const { data, error } = await createServiceClient().rpc("review_list_assignments", {
      p_actor_id: actor.userId,
      p_page: parsed.data.page,
      p_page_size: parsed.data.pageSize,
      ...(parsed.data.status ? { p_status: parsed.data.status } : {}),
    });
    if (error) return toReviewFailure(error);
    return { ok: true, data: parseMemberAssignmentsPage(data) };
  } catch (error) {
    return toReviewFailure(error);
  }
}

export async function getAssignment(findingId: string): Promise<ActionResult<MemberAssignment>> {
  const parsed = getAssignmentSchema.safeParse(findingId);
  if (!parsed.success) return invalidInput();

  try {
    const actor = await requireActor();
    const { data, error } = await createServiceClient().rpc("review_get_assignment", {
      p_actor_id: actor.userId,
      p_finding_id: parsed.data,
    });
    if (error) return toReviewFailure(error);
    return { ok: true, data: parseMemberAssignment(data) };
  } catch (error) {
    return toReviewFailure(error);
  }
}

export async function listOwnApprovals(
  input: ListOwnApprovalsInput = {},
): Promise<ActionResult<ReviewPage<OwnApprovalItem>>> {
  const parsed = listOwnApprovalsSchema.safeParse(input);
  if (!parsed.success) return invalidInput();

  try {
    const actor = await requireActor();
    const { data, error } = await createServiceClient().rpc("review_list_own_approvals", {
      p_actor_id: actor.userId,
      p_page: parsed.data.page,
      p_page_size: parsed.data.pageSize,
    });
    if (error) return toReviewFailure(error);
    return { ok: true, data: parseOwnApprovalsPage(data) };
  } catch (error) {
    return toReviewFailure(error);
  }
}

export async function getWorkflowOriginalUrl(
  versionId: string,
): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  const parsed = getAssignmentSchema.safeParse(versionId);
  if (!parsed.success) return invalidInput();

  try {
    const actor = await requireActor();
    const { data: path, error } = await createServiceClient().rpc("get_review_workflow_document_path", {
      p_user_id: actor.userId,
      p_version_id: parsed.data,
    });
    if (error) return toReviewFailure(error);
    if (typeof path !== "string" || !path) {
      return { ok: false, error: { code: "NOT_FOUND", message: "This file is unavailable." } };
    }

    // Storage's session policy intentionally denies Member reads. The service
    // client signs only the path returned by the actor-validated SQL RPC above.
    const client = createServiceClient();
    const { data: signedData, error: signedError } = await client.storage
      .from("documents")
      .createSignedUrl(path, 300);
    if (signedError || !signedData?.signedUrl) {
      const correlationId = crypto.randomUUID();
      try {
        captureOperationFailure({
          module: "review",
          operation: "read",
          code: "INTERNAL_ERROR",
          correlationId,
        });
      } catch {
        // Telemetry is best effort and cannot change the product result.
      }
      return {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "We couldn't open this file.", correlationId },
      };
    }
    return {
      ok: true,
      data: {
        url: signedData.signedUrl,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    };
  } catch (error) {
    return toReviewFailure(error);
  }
}
