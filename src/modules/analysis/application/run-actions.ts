"use server";

import { captureOperationFailure } from "@/lib/observability/operation-events";
import { IdentityError, requireDocumentActor } from "@/modules/identity";
import type {
  ActionError,
  ActionErrorCode,
  ActionResult,
  RetryAnalysisInput,
  RetryAnalysisResult,
  RunAnalysisInput,
  RunAnalysisResult,
} from "@/types/contracts";
import { readAnalysisExecutionManifest } from "../execution-config";
import { AnalysisCommandError, submitRetryCommand, submitRunCommand } from "./run-queries";
import { scheduleAnalysisTrigger } from "./worker-trigger";
import { retryAnalysisInputSchema, runAnalysisInputSchema } from "../schemas";

type RunOperation = "run" | "retry";
type FailedResult = { ok: false; error: ActionError };

function failure(code: ActionErrorCode, message: string, correlationId?: string): FailedResult {
  return { ok: false, error: { code, message, ...(correlationId ? { correlationId } : {}) } };
}

function reportInternalFailure(operation: RunOperation, message: string): FailedResult {
  const correlationId = crypto.randomUUID();
  try {
    captureOperationFailure({
      module: "analysis",
      operation,
      code: "INTERNAL_ERROR",
      correlationId,
    });
  } catch {
    // The controlled Action result is independent of telemetry availability.
  }
  return failure("INTERNAL_ERROR", message, correlationId);
}

function identityFailure(error: unknown, operation: RunOperation): FailedResult {
  if (error instanceof IdentityError) {
    if (error.code === "UNAUTHENTICATED") {
      return failure("UNAUTHENTICATED", "Please sign in to continue.");
    }
    if (error.code === "FORBIDDEN" || error.code === "WORKSPACE_REQUIRED") {
      return failure("FORBIDDEN", "Only Admins and QA Leads can run an analysis.");
    }
  }
  return reportInternalFailure(operation, "We could not verify your access to analysis. Try again.");
}

function commandFailure(error: unknown, operation: RunOperation): FailedResult {
  if (!(error instanceof AnalysisCommandError)) {
    return reportInternalFailure(operation, "We could not start this analysis. Try again.");
  }

  switch (error.code) {
    case "42501":
      return failure("FORBIDDEN", "Only Admins and QA Leads can run an analysis.");
    case "22023":
      return failure("INVALID_INPUT", "The analysis request is invalid.");
    case "P0002":
      return failure("NOT_FOUND", "The estimate or failed analysis is no longer available.");
    case "P2001":
      return failure("INSUFFICIENT_CREDITS", "There are not enough credits to reserve this analysis.");
    case "P2002":
      return failure("CONFLICT", "An analysis is already running, or this request key was used with different inputs.");
    case "P2101":
      return failure("ESTIMATE_EXPIRED", "The estimate has expired. Request a new estimate.");
    case "P2102":
      return failure("ESTIMATE_STALE", "The selected documents changed. Request a new estimate.");
    default:
      return reportInternalFailure(operation, "We could not start this analysis. Try again.");
  }
}

function scheduleAfterCommit(analysisId: string): void {
  try {
    scheduleAnalysisTrigger(analysisId);
  } catch {
    try {
      captureOperationFailure({
        module: "analysis",
        operation: "trigger",
        code: "INTERNAL_ERROR",
        correlationId: crypto.randomUUID(),
      });
    } catch {
      // The already committed analysis remains the successful result.
    }
  }
}

export async function runAnalysis(input: RunAnalysisInput): Promise<ActionResult<RunAnalysisResult>> {
  let actor;
  try {
    actor = await requireDocumentActor();
  } catch (error) {
    return identityFailure(error, "run");
  }

  const parsed = runAnalysisInputSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT", "The analysis request is invalid.");

  try {
    const manifest = readAnalysisExecutionManifest(process.env.ANALYSIS_EXECUTION_MANIFEST);
    const result = await submitRunCommand(actor.userId, parsed.data, manifest);
    scheduleAfterCommit(result.analysisId);
    return { ok: true, data: result };
  } catch (error) {
    return commandFailure(error, "run");
  }
}

export async function retryAnalysis(input: RetryAnalysisInput): Promise<ActionResult<RetryAnalysisResult>> {
  let actor;
  try {
    actor = await requireDocumentActor();
  } catch (error) {
    return identityFailure(error, "retry");
  }

  const parsed = retryAnalysisInputSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT", "The retry request is invalid.");

  try {
    const manifest = readAnalysisExecutionManifest(process.env.ANALYSIS_EXECUTION_MANIFEST);
    const result = await submitRetryCommand(actor.userId, parsed.data, manifest);
    scheduleAfterCommit(result.analysisId);
    return { ok: true, data: result };
  } catch (error) {
    return commandFailure(error, "retry");
  }
}
