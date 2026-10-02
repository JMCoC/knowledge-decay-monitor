import type {
  ActionErrorCode,
  ActionResult,
  FinalizeItemResult,
  IngestionApi,
  UploadItemInput,
  UploadItemResult,
} from "./contracts";

/** finalizeUpload takes an array; a single-item call passes a one-element array. */
const _finalize: IngestionApi["finalizeUpload"] = (versionIds: string[]) =>
  Promise.resolve({ ok: true, data: [] as FinalizeItemResult[] });

/** The per-item error reuses the envelope's code union. */
const _code: ActionErrorCode = "PROCESSING_FAILED";

const _item: UploadItemInput = {
  metadata: { name: "Runbook", category: "SOP", ownerId: "u" },
  fileName: "runbook.pdf",
  declaredMimeType: "application/pdf",
  sizeBytes: 1024,
  signature: "JVBERi0xMjM=",
};

const _ok: UploadItemResult = {
  index: 0,
  outcome: {
    ok: true,
    documentId: "d",
    versionId: "v",
    storagePath: "w/d/v/original.pdf",
    canonicalMimeType: "application/pdf",
  },
};

const _envelope: ActionResult<UploadItemResult[]> = { ok: true, data: [_ok] };

void [_finalize, _code, _item, _envelope];
