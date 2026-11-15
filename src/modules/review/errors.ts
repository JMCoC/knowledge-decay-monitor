import "server-only";

import { IdentityError } from "@/modules/identity/errors";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import type { ActionError, ActionErrorCode, ActionResult } from "@/types/contracts";

type ReviewFailure = Extract<ActionResult<never>, { ok: false }>;
type ReviewOperation = "read" | "change" | "assign" | "prepare_round" | "update_round_draft" | "open_round" | "cancel_round";

const messages: Record<Exclude<ActionErrorCode,
  | "PROCESSING_FAILED"
  | "INSUFFICIENT_CREDITS"
  | "ESTIMATE_EXPIRED"
  | "ESTIMATE_STALE"
  | "ANALYSIS_FAILED"
>, string> = {
  UNAUTHENTICATED: "Please sign in to continue.",
  FORBIDDEN: "You don't have permission to access review.",
  INVALID_INPUT: "Some review details are invalid.",
  NOT_FOUND: "This review item is unavailable.",
  CONFLICT: "This review item changed. Refresh and try again.",
  INTERNAL_ERROR: "We couldn't complete this review request.",
};

function failure(code: ActionErrorCode, correlationId?: string): ReviewFailure {
  const error: ActionError = {
    code,
    message: messages[code as keyof typeof messages] ?? messages.INTERNAL_ERROR,
    ...(correlationId ? { correlationId } : {}),
  };
  return { ok: false, error };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  try {
    if (!("code" in error)) return null;
    return typeof error.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

function identityFailureCode(error: unknown): IdentityError["code"] | null {
  try {
    return error instanceof IdentityError ? error.code : null;
  } catch {
    return null;
  }
}

function reportInternalFailure(operation: ReviewOperation): string {
  const correlationId = crypto.randomUUID();
  try {
    captureOperationFailure({
      module: "review",
      operation,
      code: "INTERNAL_ERROR",
      correlationId,
    });
  } catch {
    // Telemetry is best effort and cannot change the product result.
  }
  return correlationId;
}

/** Converts only stable identity and SQLSTATE codes to public ActionResult errors. */
export function toReviewFailure(error: unknown, operation: ReviewOperation = "read"): ReviewFailure {
  const identityCode = identityFailureCode(error);
  if (identityCode) {
    switch (identityCode) {
      case "UNAUTHENTICATED":
        return failure("UNAUTHENTICATED");
      case "FORBIDDEN":
      case "WORKSPACE_REQUIRED":
        return failure("FORBIDDEN");
      case "INTERNAL_ERROR":
        return failure("INTERNAL_ERROR", reportInternalFailure(operation));
    }
  }

  const code = errorCode(error);
  switch (code) {
    case "P0002":
      return failure("NOT_FOUND");
    case "42501":
      return failure("FORBIDDEN");
    case "22023":
      return failure("INVALID_INPUT");
    case "P0001":
    case "55P03":
    case "40P01":
      return failure("CONFLICT");
    default:
      return failure("INTERNAL_ERROR", reportInternalFailure(operation));
  }
}
