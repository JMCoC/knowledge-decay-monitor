import "server-only";

import { createHash } from "node:crypto";
import type { UploadState } from "@/types/contracts";
import {
  canonicalMimeFor,
  isSignatureConsistent,
  MAX_FILE_SIZE_BYTES,
  type AllowedExtension,
} from "./validation";
import { downloadStorageObject, uploadStorageObject } from "./storage";

export type VerificationFailureCode = "INVALID_INPUT" | "INTERNAL_ERROR";

export class UploadVerificationError extends Error {
  constructor(readonly code: VerificationFailureCode) {
    super("Upload verification failed.");
    this.name = "UploadVerificationError";
  }
}

export interface VerificationClaim {
  versionId: string;
  attemptId: string;
  operationId: string | null;
  workspaceId: string;
  temporaryPath: string;
  canonicalPath: string;
  expectedSha256: string;
  expectedSizeBytes: number;
  canonicalMimeType: string;
  uploadState: UploadState;
}

export interface VerificationResult {
  state: "confirmed" | "rejected" | "pending";
  error?: "INTERNAL_ERROR";
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_PATH = new RegExp(`^(${UUID})/(${UUID})/(${UUID})/original\\.(pdf|docx|md)$`, "i");
const ATTEMPT_PATH = new RegExp(`^(${UUID})/(${UUID})/(${UUID})/attempts/(${UUID})/original\\.(pdf|docx|md)$`, "i");
const VERIFY_BUDGET_MS = 60_000;

function uploadExtension(claim: VerificationClaim): AllowedExtension | null {
  const canonical = CANONICAL_PATH.exec(claim.canonicalPath);
  const temporary = ATTEMPT_PATH.exec(claim.temporaryPath);
  if (!canonical || !temporary) return null;
  if (
    canonical[1]?.toLowerCase() !== claim.workspaceId.toLowerCase()
    || canonical[3]?.toLowerCase() !== claim.versionId.toLowerCase()
    || temporary[1]?.toLowerCase() !== canonical[1]?.toLowerCase()
    || temporary[2]?.toLowerCase() !== canonical[2]?.toLowerCase()
    || temporary[3]?.toLowerCase() !== canonical[3]?.toLowerCase()
    || temporary[4]?.toLowerCase() !== claim.attemptId.toLowerCase()
    || temporary[5]?.toLowerCase() !== canonical[4]?.toLowerCase()
  ) return null;
  const extension = canonical[4]?.toLowerCase();
  return extension === "pdf" || extension === "docx" || extension === "md" ? extension : null;
}

function exactBytesMatch(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Reads a response stream with an actual-byte ceiling; Content-Length is advisory only. */
export async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new UploadVerificationError("INTERNAL_ERROR");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => {
      reject(new UploadVerificationError("INTERNAL_ERROR"));
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        completed = true;
        break;
      }
      if (totalBytes + value.byteLength > MAX_FILE_SIZE_BYTES) {
        throw new UploadVerificationError("INVALID_INPUT");
      }
      totalBytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function reconcileCanonical(
  claim: VerificationClaim,
  verifiedBytes: Uint8Array,
  signal: AbortSignal,
): Promise<VerificationResult> {
  try {
    const response = await downloadStorageObject(claim.canonicalPath, signal);
    if (!response) return { state: "pending", error: "INTERNAL_ERROR" };
    const existingBytes = await readBoundedBody(response, signal);
    return exactBytesMatch(verifiedBytes, existingBytes)
      ? { state: "confirmed" }
      : { state: "pending", error: "INTERNAL_ERROR" };
  } catch {
    return { state: "pending", error: "INTERNAL_ERROR" };
  }
}

/** Verifies immutable bytes, publishes without overwrite, and reconciles uncertain writes. */
export async function verifyAndPromote(claim: VerificationClaim): Promise<VerificationResult> {
  if (claim.uploadState === "confirmed") return { state: "confirmed" };
  if (
    !claim.operationId
    || !Number.isSafeInteger(claim.expectedSizeBytes)
    || claim.expectedSizeBytes < 1
    || claim.expectedSizeBytes > MAX_FILE_SIZE_BYTES
    || !/^[0-9a-f]{64}$/.test(claim.expectedSha256)
  ) return { state: "pending", error: "INTERNAL_ERROR" };

  const extension = uploadExtension(claim);
  if (!extension || claim.canonicalMimeType !== canonicalMimeFor(extension)) {
    return { state: "pending", error: "INTERNAL_ERROR" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_BUDGET_MS);
  try {
    const temporaryResponse = await downloadStorageObject(claim.temporaryPath, controller.signal);
    if (!temporaryResponse) return { state: "pending" };

    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(temporaryResponse, controller.signal);
    } catch (error) {
      if (error instanceof UploadVerificationError && error.code === "INVALID_INPUT") {
        return { state: "rejected" };
      }
      return { state: "pending", error: "INTERNAL_ERROR" };
    }

    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.byteLength !== claim.expectedSizeBytes
      || actualSha256 !== claim.expectedSha256
      || !isSignatureConsistent(extension, bytes.subarray(0, Math.min(8, bytes.byteLength)))
    ) return { state: "rejected" };

    try {
      const published = await uploadStorageObject(
        claim.canonicalPath,
        bytes,
        claim.canonicalMimeType,
        controller.signal,
      );
      if (published === "created") return { state: "confirmed" };
    } catch {
      // A lost response may follow a successful write; resolve it from the exact canonical bytes.
    }
    return reconcileCanonical(claim, bytes, controller.signal);
  } catch {
    return { state: "pending", error: "INTERNAL_ERROR" };
  } finally {
    clearTimeout(timeout);
  }
}
