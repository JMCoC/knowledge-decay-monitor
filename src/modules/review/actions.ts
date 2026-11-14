"use server";

import "server-only";

import { requireDocumentActor } from "@/modules/identity";
import { createServiceClient } from "@/lib/supabase/service";
import type { ActionResult, EligibleOwner } from "@/types/contracts";
import type {
  FindingReviewSnapshot,
  GetFindingReviewInput,
  GetRoundDraftInput,
  ListAssigneesInput,
  ReviewPage,
  RoundDraftSnapshot,
} from "@/types/review-contracts";
import {
  getFindingReviewSchema,
  getRoundDraftSchema,
  reviewPageSchema,
} from "./schemas";
import { toReviewFailure } from "./errors";
import {
  parseAssigneesPage,
  parseFindingReviewSnapshot,
  parseRoundDraftSnapshot,
} from "./mappers";

function invalidInput<T>(): ActionResult<T> {
  return { ok: false, error: { code: "INVALID_INPUT", message: "Some review details are invalid." } };
}

export async function listAssignees(
  input: ListAssigneesInput = {},
): Promise<ActionResult<ReviewPage<EligibleOwner>>> {
  const parsed = reviewPageSchema.safeParse(input);
  if (!parsed.success) return invalidInput();

  try {
    const actor = await requireDocumentActor();
    const { data, error } = await createServiceClient().rpc("review_list_assignees", {
      p_actor_id: actor.userId,
      p_page: parsed.data.page,
      p_page_size: parsed.data.pageSize,
    });
    if (error) return toReviewFailure(error);
    return { ok: true, data: parseAssigneesPage(data) };
  } catch (error) {
    return toReviewFailure(error);
  }
}

export async function getFindingReview(
  input: GetFindingReviewInput,
): Promise<ActionResult<FindingReviewSnapshot>> {
  const parsed = getFindingReviewSchema.safeParse(input);
  if (!parsed.success) return invalidInput();

  try {
    const actor = await requireDocumentActor();
    const { data, error } = await createServiceClient().rpc("review_get_finding", {
      p_actor_id: actor.userId,
      p_finding_id: parsed.data.findingId,
    });
    if (error) return toReviewFailure(error);
    return { ok: true, data: parseFindingReviewSnapshot(data) };
  } catch (error) {
    return toReviewFailure(error);
  }
}

export async function getRoundDraft(
  input: GetRoundDraftInput,
): Promise<ActionResult<RoundDraftSnapshot>> {
  const parsed = getRoundDraftSchema.safeParse(input);
  if (!parsed.success) return invalidInput();

  try {
    const actor = await requireDocumentActor();
    const { data, error } = await createServiceClient().rpc("review_get_round_draft", {
      p_actor_id: actor.userId,
      p_round_id: parsed.data.roundId,
    });
    if (error) return toReviewFailure(error);
    return { ok: true, data: parseRoundDraftSnapshot(data) };
  } catch (error) {
    return toReviewFailure(error);
  }
}
