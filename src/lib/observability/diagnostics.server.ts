import "server-only";

import * as Sentry from "@sentry/nextjs";
import type { ActionError, ActionResult } from "../../types/contracts";
import { IdentityError } from "../../modules/identity/errors";
import { requireActor } from "../../modules/identity/session";
import { captureSafeFailure } from "./capture";
import {
  canRunDiagnostics,
  isDiagnosticExpiryActive,
  isDiagnosticOperatorId,
  type DiagnosticPolicy,
} from "./diagnostics-policy";

function readDiagnosticPolicy(): DiagnosticPolicy {
  const rawOperatorIds = process.env.KDM_SENTRY_DIAGNOSTICS_OPERATOR_IDS;
  const operatorIds =
    typeof rawOperatorIds === "string" && rawOperatorIds.trim()
      ? rawOperatorIds.split(",").map((id) => id.trim())
      : [];
  const expiresAt = process.env.KDM_SENTRY_DIAGNOSTICS_EXPIRES_AT?.trim() ?? "";

  return {
    enabled:
      process.env.KDM_SENTRY_DIAGNOSTICS_ENABLED === "1" &&
      operatorIds.length > 0 &&
      operatorIds.every(isDiagnosticOperatorId) &&
      isDiagnosticExpiryActive(expiresAt, Date.now()),
    operatorIds,
    expiresAt,
  };
}

const unavailable: ActionError = {
  code: "FORBIDDEN",
  message: "Diagnostics are not available for this account.",
};
const internalFailure: ActionError = {
  code: "INTERNAL_ERROR",
  message: "We couldn't submit the diagnostic. Try again.",
};

function mapIdentityFailure(error: unknown): ActionError {
  if (error instanceof IdentityError && error.code === "UNAUTHENTICATED") {
    return { code: "UNAUTHENTICATED", message: "Sign in with an authorized operator account." };
  }
  if (error instanceof IdentityError && error.code === "INTERNAL_ERROR") return internalFailure;
  return unavailable;
}

export async function authorizeDiagnosticRequest(): Promise<ActionResult<{ expiresAt: string }>> {
  const policy = readDiagnosticPolicy();
  if (!policy.enabled) return { ok: false, error: unavailable };

  let actor;
  try {
    actor = await requireActor();
  } catch (error) {
    return { ok: false, error: mapIdentityFailure(error) };
  }

  if (!canRunDiagnostics(actor, policy, Date.now())) {
    return { ok: false, error: unavailable };
  }

  return { ok: true, data: { expiresAt: policy.expiresAt } };
}

export async function emitServerDiagnostic(): Promise<
  ActionResult<{ correlationId: string; eventId?: string; flushed: boolean }>
> {
  const authorization = await authorizeDiagnosticRequest();
  if (!authorization.ok) return authorization;

  let receipt;
  try {
    try {
      throw new Error("Synthetic observability diagnostic.");
    } catch {
      receipt = captureSafeFailure({
        module: "application",
        operation: "diagnostic",
        code: "INTERNAL_ERROR",
        synthetic: true,
      });
    }
  } catch {
    return { ok: false, error: internalFailure };
  }

  if (!receipt) return { ok: false, error: internalFailure };

  let flushed = false;
  try {
    flushed = await Sentry.flush(2000);
  } catch {
    flushed = false;
  }

  return {
    ok: true,
    data: {
      correlationId: receipt.correlationId,
      ...(receipt.eventId ? { eventId: receipt.eventId } : {}),
      flushed,
    },
  };
}
