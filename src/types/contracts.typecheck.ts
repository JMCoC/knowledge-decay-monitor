import type {
  ActionError,
  ActionErrorCode,
  ActionResult,
  IngestionApi,
  UploadItemInput,
  UploadItemResult,
  UploadSnapshot,
} from "./contracts";

const _finalize: IngestionApi["finalizeUpload"] = (input) =>
  Promise.resolve({
    ok: true,
    data: {
      versionId: input.versionId,
      uploadState: "pending",
      attemptId: input.attemptId,
      canOpen: false,
      canResume: true,
      canRecover: false,
    },
  });

const _code: ActionErrorCode = "CONFLICT";
const _failure: ActionError = {
  code: "INTERNAL_ERROR",
  message: "Something went wrong.",
  correlationId: "40000000-0000-4000-8000-000000000009",
};

const _item: UploadItemInput = {
  metadata: { name: "Runbook", category: "SOP", ownerId: "u" },
  fileName: "runbook.pdf",
  declaredMimeType: "application/pdf",
  sizeBytes: 1024,
  signature: "JVBERi0xMjM=",
  idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
  sha256: "a".repeat(64),
};

const _ok: UploadItemResult = {
  index: 0,
  outcome: {
    ok: true,
    documentId: "d",
    target: {
      versionId: "v",
      attemptId: "a",
      storagePath: "w/d/v/attempts/a/original.pdf",
      canonicalMimeType: "application/pdf",
    },
  },
};

const _envelope: ActionResult<UploadItemResult[]> = { ok: true, data: [_ok] };
const _snapshot: UploadSnapshot = {
  versionId: "v",
  uploadState: null,
  attemptId: null,
  canOpen: false,
  canResume: true,
  canRecover: false,
};

void [_finalize, _code, _failure, _item, _envelope, _snapshot];
