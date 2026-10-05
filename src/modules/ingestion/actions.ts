"use server";

import { IdentityError, requireDocumentActor } from "@/modules/identity";
import type {
  ActionError,
  ActionErrorCode,
  ActionResult,
  Actor,
  UploadItemInput,
  UploadItemResult,
  UploadReference,
  UploadSnapshot,
  UploadTarget,
} from "@/types/contracts";
import { z } from "zod";
import {
  computeRequestFingerprint,
  finalizeUploadRecord,
  getUploadSnapshot,
  reserveUploadRecord,
  recoverUploadRecord,
  resumeUploadRecord,
  UploadStoreError,
} from "./upload-store";
import {
  finalizeUploadSchema,
  uploadBatchSchema,
  uploadItemSchema,
  uploadReferenceSchema,
} from "./schemas";
import { actionCodeForSqlstate, extensionFromFileName } from "./validation";
import { captureOperationFailure } from "@/lib/observability/operation-events";

const GENERIC_OWNER_MESSAGE = "The selected owner is not available.";
const GENERIC_UPLOAD_MESSAGE = "This file cannot be uploaded.";
const GENERIC_INTERNAL_MESSAGE = "Something went wrong. Try again.";
const VERSION_ID_SCHEMA = z.string().uuid();

type FailedResult = { ok: false; error: ActionError };
type IngestionOperation = "reserve" | "verify" | "resume" | "recover";

function failure(code: ActionErrorCode, message: string, correlationId?: string): FailedResult {
  return { ok: false, error: { code, message, ...(correlationId ? { correlationId } : {}) } };
}

function reportInternalFailure(operation: IngestionOperation, message: string): FailedResult {
  const correlationId = crypto.randomUUID();
  try {
    captureOperationFailure({
      module: "ingestion",
      operation,
      code: "INTERNAL_ERROR",
      correlationId,
    });
  } catch {
    // Telemetry must not change the controlled product result.
  }
  return failure("INTERNAL_ERROR", message, correlationId);
}

function identityFailure(error: unknown): FailedResult | null {
  if (!(error instanceof IdentityError)) return null;
  switch (error.code) {
    case "UNAUTHENTICATED":
      return failure("UNAUTHENTICATED", "Please sign in before uploading.");
    case "FORBIDDEN":
    case "WORKSPACE_REQUIRED":
      return failure("FORBIDDEN", "Only Admins and QA Leads can manage documents.");
    default:
      return failure("INTERNAL_ERROR", GENERIC_INTERNAL_MESSAGE);
  }
}

function storeErrorCode(error: unknown): ActionErrorCode {
  if (!(error instanceof UploadStoreError)) return "INTERNAL_ERROR";
  if (!error.sqlstate) return "INTERNAL_ERROR";
  return actionCodeForSqlstate(error.sqlstate) ?? "INTERNAL_ERROR";
}

function storeErrorMessage(code: ActionErrorCode, options: { ownerFailure?: boolean } = {}): string {
  const ownerFailure = options.ownerFailure ?? false;
  if (ownerFailure && code === "INVALID_INPUT") return GENERIC_OWNER_MESSAGE;
  if (code === "NOT_FOUND") return "That upload is no longer available.";
  if (code === "CONFLICT") return "The upload changed or is already being processed. Refresh and try again.";
  if (code === "FORBIDDEN") return "Only Admins and QA Leads can manage documents.";
  if (code === "INVALID_INPUT") return "The upload details are invalid.";
  return GENERIC_UPLOAD_MESSAGE;
}

async function documentActor(operation: IngestionOperation): Promise<Actor | FailedResult> {
  try {
    return await requireDocumentActor();
  } catch (error) {
    const denied = identityFailure(error);
    if (denied && denied.error.code !== "INTERNAL_ERROR") return denied;
    return reportInternalFailure(operation, denied?.error.message ?? GENERIC_INTERNAL_MESSAGE);
  }
}

function isFailure(value: Actor | FailedResult): value is FailedResult {
  return "ok" in value;
}

export async function reserveUpload(items: UploadItemInput[]): Promise<ActionResult<UploadItemResult[]>> {
  const batch = uploadBatchSchema.safeParse(items);
  if (!batch.success) {
    return failure("INVALID_INPUT", "Select between 1 and 10 PDF, DOCX or Markdown files.");
  }

  const actor = await documentActor("reserve");
  if (isFailure(actor)) return actor;

  const results: UploadItemResult[] = [];
  for (const [index, entry] of batch.data.entries()) {
    const parsed = uploadItemSchema.safeParse(entry);
    if (!parsed.success) {
      results.push({
        index,
        outcome: {
          ok: false,
          error: { code: "INVALID_INPUT", message: "This file does not match the upload requirements." },
        },
      });
      continue;
    }

    const item = parsed.data;
    const extension = extensionFromFileName(item.fileName);
    if (!extension) {
      results.push({
        index,
        outcome: { ok: false, error: { code: "INVALID_INPUT", message: "Only PDF, DOCX and Markdown are accepted." } },
      });
      continue;
    }

    try {
      const requestFingerprint = await computeRequestFingerprint(item, extension);
      const reservation = await reserveUploadRecord({
        userId: actor.userId,
        idempotencyKey: item.idempotencyKey,
        requestFingerprint,
        name: item.metadata.name,
        category: item.metadata.category,
        ownerId: item.metadata.ownerId,
        extension,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
      });
      results.push({
        index,
        outcome: {
          ok: true,
          documentId: reservation.documentId,
          target: {
            versionId: reservation.versionId,
            attemptId: reservation.attemptId,
            storagePath: reservation.storagePath,
            canonicalMimeType: reservation.canonicalMimeType,
          },
        },
      });
    } catch (error) {
      const denied = identityFailure(error);
      if (denied) {
        results.push({ index, outcome: { ok: false, error: denied.error } });
        continue;
      }
      const code = storeErrorCode(error);
      const message = storeErrorMessage(code, { ownerFailure: error instanceof UploadStoreError && error.sqlstate === "22023" });
      const failureResult = code === "INTERNAL_ERROR"
        ? reportInternalFailure("reserve", message)
        : failure(code, message);
      results.push({
        index,
        outcome: {
          ok: false,
          error: failureResult.error,
        },
      });
    }
  }
  return { ok: true, data: results };
}

export async function getUploadState(versionId: string): Promise<ActionResult<UploadSnapshot>> {
  if (!VERSION_ID_SCHEMA.safeParse(versionId).success) {
    return failure("INVALID_INPUT", "The version ID is invalid.");
  }
  const actor = await documentActor("resume");
  if (isFailure(actor)) return actor;
  try {
    const snapshot = await getUploadSnapshot(actor.userId, versionId);
    return snapshot
      ? { ok: true, data: snapshot }
      : failure("NOT_FOUND", "That upload is no longer available.");
  } catch (error) {
    const denied = identityFailure(error);
    if (denied) return denied;
    const code = storeErrorCode(error);
    return code === "INTERNAL_ERROR"
      ? reportInternalFailure("resume", storeErrorMessage(code))
      : failure(code, storeErrorMessage(code));
  }
}

export async function finalizeUpload(input: {
  versionId: string;
  attemptId: string;
}): Promise<ActionResult<UploadSnapshot>> {
  const parsed = finalizeUploadSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT", "The upload reference is invalid.");
  const actor = await documentActor("verify");
  if (isFailure(actor)) return actor;
  try {
    return { ok: true, data: await finalizeUploadRecord(actor.userId, parsed.data.versionId, parsed.data.attemptId) };
  } catch (error) {
    const denied = identityFailure(error);
    if (denied) return denied;
    const code = storeErrorCode(error);
    return code === "INTERNAL_ERROR"
      ? reportInternalFailure("verify", storeErrorMessage(code))
      : failure(code, storeErrorMessage(code));
  }
}

export async function resumeUpload(
  versionId: string,
  reference?: UploadReference,
): Promise<ActionResult<UploadTarget | UploadSnapshot>> {
  if (!VERSION_ID_SCHEMA.safeParse(versionId).success) {
    return failure("INVALID_INPUT", "The version ID is invalid.");
  }
  let validatedReference: UploadReference | undefined;
  if (reference !== undefined) {
    const parsedReference = uploadReferenceSchema.safeParse(reference);
    if (!parsedReference.success) return failure("INVALID_INPUT", "The selected file reference is invalid.");
    validatedReference = parsedReference.data;
  }

  const actor = await documentActor("resume");
  if (isFailure(actor)) return actor;
  try {
    const result = await resumeUploadRecord(actor.userId, versionId, validatedReference);
    return result
      ? { ok: true, data: result }
      : failure("NOT_FOUND", "That upload is no longer available.");
  } catch (error) {
    const denied = identityFailure(error);
    if (denied) return denied;
    const code = storeErrorCode(error);
    return code === "INTERNAL_ERROR"
      ? reportInternalFailure("resume", storeErrorMessage(code))
      : failure(code, storeErrorMessage(code));
  }
}

export async function recoverUpload(versionId: string): Promise<ActionResult<UploadSnapshot>> {
  if (!VERSION_ID_SCHEMA.safeParse(versionId).success) {
    return failure("INVALID_INPUT", "The version ID is invalid.");
  }
  const actor = await documentActor("recover");
  if (isFailure(actor)) return actor;
  try {
    return { ok: true, data: await recoverUploadRecord(actor.userId, versionId) };
  } catch (error) {
    const denied = identityFailure(error);
    if (denied) return denied;
    const code = storeErrorCode(error);
    return code === "INTERNAL_ERROR"
      ? reportInternalFailure("recover", storeErrorMessage(code))
      : failure(code, storeErrorMessage(code));
  }
}
