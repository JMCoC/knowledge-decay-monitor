"use server";

import * as Sentry from "@sentry/nextjs";
import { IdentityError, requireActor } from "@/modules/identity";
import { createReadOnlyClient } from "@/lib/supabase/server";
import type {
  ActionErrorCode,
  ActionResult,
  Actor,
  DocumentCategory,
  FinalizeItemResult,
  UploadItemInput,
  UploadItemResult,
} from "@/types/contracts";
import { startProcessing } from "./processing";
import { finalizeBatchSchema, uploadBatchSchema, uploadItemSchema } from "./schemas";
import { actionCodeForSqlstate, canonicalMimeFor, extensionFromFileName } from "./validation";

const GENERIC_OWNER_MESSAGE = "The selected owner is not available.";
const MISSING_OBJECT_MESSAGE = "The file did not reach storage. Try the upload again.";
const SIZE_MISMATCH_MESSAGE = "The stored file does not match the file you selected.";

/**
 * Typed against the Task 5 migration, not against today's database.ts.
 * Until Dev 1 regenerates types, reserve_document is invisible to TS: this
 * narrow cast is the only untyped seam, and it disappears with the regen.
 */
// TODO(s1-03): remove cast after database.ts regeneration (Task 5)
type ReserveDocumentFn = (
  fn: "reserve_document",
  args: {
    p_document_id: string;
    p_version_id: string;
    p_name: string;
    p_category: DocumentCategory;
    p_owner_id: string;
    p_extension: string;
    p_size_bytes: number;
  },
) => Promise<{ data: string | null; error: { code: string } | null }>;

/**
 * The row finalizeUpload reads. size_bytes is guaranteed by the Task 5
 * migration; database.ts catches up at regen.
 */
// TODO(s1-03): remove cast after database.ts regeneration (Task 5)
interface FinalizeVersionRow {
  id: string;
  storage_path: string;
  size_bytes: number | null;
}

function internalError(): ActionResult<never> {
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Try again." },
  };
}

function reportToSentry(
  operation: "ingestion.reserve" | "ingestion.finalize",
  error: unknown,
  tags: Record<string, string | number>,
) {
  Sentry.captureException(error, {
    tags: { operation, ...tags },
  });
}

type Gate = { actor: Actor } | { failure: ActionResult<never> };

/**
 * The single identity + role gate for both actions (decision B2.2).
 * requireActor() resolves any workspace member, including Member, so the
 * privileged-role check lives here: identity does not know which roles each
 * action accepts. RLS in Day Cero is scoped by tenant, not by role, so this
 * guard is not redundant with it — a Member of Workspace A can read a
 * version of Workspace A, and without the check could close someone else's
 * reservation and get `ok: true` back.
 *
 * WORKSPACE_REQUIRED (signed in, no workspace yet) maps to FORBIDDEN
 * (decision B2.3): it is a normal account state, not a defect, so it must
 * not reach Sentry.
 */
async function requirePrivilegedActor(
  operation: "ingestion.reserve" | "ingestion.finalize",
  tags: Record<string, string | number>,
): Promise<Gate> {
  try {
    const actor = await requireActor();
    if (actor.role !== "Admin" && actor.role !== "QA Lead") {
      return {
        failure: {
          ok: false,
          error: { code: "FORBIDDEN", message: "Only Admins and QA Leads can upload." },
        },
      };
    }
    return { actor };
  } catch (error) {
    if (error instanceof IdentityError) {
      if (error.code === "WORKSPACE_REQUIRED") {
        return {
          failure: {
            ok: false,
            error: { code: "FORBIDDEN", message: "Set up your workspace before uploading." },
          },
        };
      }
      return { failure: { ok: false, error: { code: error.code, message: error.message } } };
    }
    reportToSentry(operation, error, tags);
    return { failure: internalError() };
  }
}

/**
 * Reserves every item in the batch. One call so the server sees the whole batch
 * and can reject it in one trip; the loop is per item so one bad file cannot
 * take the others down.
 */
export async function reserveUpload(
  items: UploadItemInput[],
): Promise<ActionResult<UploadItemResult[]>> {
  const batch = uploadBatchSchema.safeParse(items);
  if (!batch.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Select between 1 and 10 PDF, DOCX or Markdown files.",
      },
    };
  }

  let actor: Actor;
  {
    const gate = await requirePrivilegedActor("ingestion.reserve", {
      batch_size: batch.data.length,
    });
    if ("failure" in gate) return gate.failure;
    actor = gate.actor;
  }

  const supabase = await createReadOnlyClient();
  const callReserveDocument = supabase.rpc as unknown as ReserveDocumentFn;
  const results: UploadItemResult[] = [];

  for (const [index, entry] of batch.data.entries()) {
    const item = uploadItemSchema.safeParse(entry);
    if (!item.success) {
      results.push({
        index,
        outcome: {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: item.error.issues[0]?.message ?? "This file cannot be uploaded.",
          },
        },
      });
      continue;
    }

    const extension = extensionFromFileName(item.data.fileName);
    if (extension === null) {
      results.push({
        index,
        outcome: {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "Only PDF, DOCX and Markdown files are accepted.",
          },
        },
      });
      continue;
    }

    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();

    // A rejected RPC arrives as { error }; a dead connection throws. Both
    // are item-level failures: the envelope stays ok (spec §8.2).
    let rpcResult: Awaited<ReturnType<ReserveDocumentFn>>;
    try {
      rpcResult = await callReserveDocument("reserve_document", {
        p_document_id: documentId,
        p_version_id: versionId,
        p_name: item.data.metadata.name,
        p_category: item.data.metadata.category,
        p_owner_id: item.data.metadata.ownerId,
        p_extension: extension,
        p_size_bytes: item.data.sizeBytes,
      });
    } catch (error) {
      reportToSentry("ingestion.reserve", error, {
        workspace_id: actor.workspaceId,
        user_id: actor.userId,
        role: actor.role,
        document_id: documentId,
        version_id: versionId,
        item_index: index,
        batch_size: batch.data.length,
      });
      results.push({
        index,
        outcome: {
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "This file cannot be uploaded." },
        },
      });
      continue;
    }

    const { data, error } = rpcResult;
    // No row, no error, no path is an impossible server state. Reported as
    // a defect, never surfaced as detail.
    if (error || data === null) {
      const code: ActionErrorCode = error
        ? (actionCodeForSqlstate(error.code) ?? "INTERNAL_ERROR")
        : "INTERNAL_ERROR";
      if (code === "INTERNAL_ERROR") {
        reportToSentry("ingestion.reserve", error ?? new Error("reserve_document returned null data"), {
          workspace_id: actor.workspaceId,
          user_id: actor.userId,
          role: actor.role,
          document_id: documentId,
          version_id: versionId,
          item_index: index,
          batch_size: batch.data.length,
          sqlstate: error?.code ?? "null-data",
        });
      }
      results.push({
        index,
        outcome: {
          ok: false,
          error: {
            code,
            // A foreign owner gets the same message as a malformed one, so the
            // response cannot be used to enumerate ids across tenants.
            message: code === "INVALID_INPUT" ? GENERIC_OWNER_MESSAGE : "This file cannot be uploaded.",
          },
        },
      });
      continue;
    }

    results.push({
      index,
      outcome: {
        ok: true,
        documentId,
        versionId,
        storagePath: data,
        canonicalMimeType: canonicalMimeFor(extension),
      },
    });
  }

  return { ok: true, data: results };
}

/**
 * Read-only. Confirms in the server what the browser claimed, and is the call
 * site S1-04 replaces without touching the rest of this file. An ok result
 * means the bytes are in place, not that the document is valid: `list()` reads
 * object metadata, never the content.
 */
export async function finalizeUpload(
  versionIds: string[],
): Promise<ActionResult<FinalizeItemResult[]>> {
  const batch = finalizeBatchSchema.safeParse(versionIds);
  if (!batch.success) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Nothing to confirm." },
    };
  }

  let actor: Actor;
  {
    const gate = await requirePrivilegedActor("ingestion.finalize", {
      batch_size: batch.data.length,
    });
    if ("failure" in gate) return gate.failure;
    actor = gate.actor;
  }

  const supabase = await createReadOnlyClient();
  const results: FinalizeItemResult[] = [];

  for (const versionId of batch.data) {
    // A dead connection throws instead of returning { error }. Either way
    // the failure is per version, and the envelope stays ok (spec §8.2).
    try {
      const { data: rawVersion, error: readError } = await supabase
        .from("document_versions")
        .select("id, storage_path, size_bytes")
        .eq("id", versionId)
        .maybeSingle();

      if (readError) {
        reportToSentry("ingestion.finalize", readError, {
          workspace_id: actor.workspaceId,
          user_id: actor.userId,
          version_id: versionId,
        });
        results.push({
          versionId,
          outcome: { ok: false, error: { code: "INTERNAL_ERROR", message: "Could not confirm the upload." } },
        });
        continue;
      }

      // RLS already scoped the read to the caller's tenant, so a null row is
      // either an unknown id or another tenant's. Both answer the same way.
      const version = rawVersion as unknown as FinalizeVersionRow | null;
      if (!version) {
        results.push({
          versionId,
          outcome: { ok: false, error: { code: "NOT_FOUND", message: "That upload is no longer available." } },
        });
        continue;
      }

      const storagePath: string = version.storage_path;
      const lastSlash = storagePath.lastIndexOf("/");
      const prefix = storagePath.slice(0, lastSlash);
      const fileName = storagePath.slice(lastSlash + 1);

      const { data: objects, error: listError } = await supabase.storage
        .from("documents")
        .list(prefix);

      if (listError) {
        reportToSentry("ingestion.finalize", listError, {
          workspace_id: actor.workspaceId,
          user_id: actor.userId,
          version_id: versionId,
        });
        results.push({
          versionId,
          outcome: { ok: false, error: { code: "INTERNAL_ERROR", message: "Could not confirm the upload." } },
        });
        continue;
      }

      const entries = (objects ?? []) as unknown as Array<{ name: string; size: number }>;
      const stored = entries.find((object) => object.name === fileName);
      if (!stored) {
        results.push({
          versionId,
          outcome: { ok: false, error: { code: "INVALID_INPUT", message: MISSING_OBJECT_MESSAGE } },
        });
        continue;
      }

      const recordedSize: number | null = version.size_bytes;
      if (recordedSize !== null && stored.size !== recordedSize) {
        results.push({
          versionId,
          outcome: { ok: false, error: { code: "INVALID_INPUT", message: SIZE_MISMATCH_MESSAGE } },
        });
        continue;
      }

      const processingStatus = await startProcessing(versionId, supabase);
      results.push({ versionId, outcome: { ok: true, processingStatus } });
    } catch (error) {
      reportToSentry("ingestion.finalize", error, {
        workspace_id: actor.workspaceId,
        user_id: actor.userId,
        version_id: versionId,
      });
      results.push({
        versionId,
        outcome: { ok: false, error: { code: "INTERNAL_ERROR", message: "Could not confirm the upload." } },
      });
    }
  }

  return { ok: true, data: results };
}
