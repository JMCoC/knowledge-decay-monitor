import type { ActionErrorCode } from "@/types/contracts";

/** The only three extensions the schema's storage_path CHECK admits. */
export type AllowedExtension = "pdf" | "docx" | "md";

/** Bucket file_size_limit, frozen in Day Cero at 10 MiB. */
export const MAX_FILE_SIZE_BYTES = 10_485_760;

const CANONICAL_MIME: Record<AllowedExtension, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
};

const ACCEPTED_DECLARED_MIME: Record<AllowedExtension, readonly string[]> = {
  pdf: [CANONICAL_MIME.pdf],
  docx: [CANONICAL_MIME.docx],
  md: [
    "text/markdown",
    "text/markdown; charset=utf-8",
    "text/plain",
    "text/plain; charset=utf-8",
  ],
};

/** Leading bytes that identify each format. `md` has none, so it is null. */
const SIGNATURE_PREFIX: Record<AllowedExtension, readonly number[] | null> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
  docx: [0x50, 0x4b, 0x03, 0x04],
  md: null,
};

/**
 * Eight bytes encode to exactly 12 characters: 11 of data plus one `=`. A length
 * of 11 is never valid base64, so the padding is not optional. The pattern is
 * what rejects garbage, because `atob` throws on invalid input rather than
 * skipping characters the way a lenient decoder would.
 */
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{11}=$/;

const SQLSTATE_TO_ACTION_CODE: Record<string, ActionErrorCode> = {
  "22023": "INVALID_INPUT",
  "23503": "INVALID_INPUT",
  "42501": "FORBIDDEN",
  "23514": "INTERNAL_ERROR",
  "23505": "INTERNAL_ERROR",
};

/**
 * Extension from the client-supplied name, matched against the allowlist. The
 * result is what the RPC and the CHECK both key on, so an unlisted extension
 * never becomes a path.
 */
export function extensionFromFileName(fileName: string): AllowedExtension | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  const extension = match?.[1]?.toLowerCase();
  if (extension === "pdf" || extension === "docx" || extension === "md") {
    return extension;
  }
  return null;
}

/** What Storage must be told. Never `file.type`, which browsers disagree on. */
export function canonicalMimeFor(extension: AllowedExtension): string {
  return CANONICAL_MIME[extension];
}

/** Whether the client's claim is compatible with the extension we derived. */
export function isDeclaredMimeConsistent(
  extension: AllowedExtension,
  declared: string,
): boolean {
  return ACCEPTED_DECLARED_MIME[extension].includes(declared.trim().toLowerCase());
}

/**
 * The first 8 bytes as a Uint8Array, or null when the encoding is not exact.
 *
 * `atob`, not `Buffer.from`. This module reaches the browser through the
 * schemas that `index.ts` re-exports for the upload form, and `Buffer` would
 * drag a Node polyfill into the client bundle. `atob` is a global in browsers,
 * in Node and in the Edge runtime, so one implementation serves all three.
 * `Uint8Array` is what `Buffer` extends, so the tests can still pass `Buffer`
 * values in without a cast.
 */
export function decodeSignature(signature: string): Uint8Array | null {
  if (!SIGNATURE_BASE64.test(signature)) {
    return null;
  }
  // The pattern already pins this at 12 characters, so the check below cannot
  // fail. It stays because a decoder that silently returns the wrong length is
  // the kind of bug that only shows up in production.
  const binary = atob(signature);
  if (binary.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Prefix check only. A DOCX is a ZIP, so this cannot tell the two apart, and
 * nothing here says anything about a Markdown file. See the spec's §3.1.
 */
export function isSignatureConsistent(
  extension: AllowedExtension,
  bytes: Uint8Array,
): boolean {
  const prefix = SIGNATURE_PREFIX[extension];
  if (prefix === null) {
    return true;
  }
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((byte, position) => bytes[position] === byte);
}

export function isValidFileSize(sizeBytes: number): boolean {
  return (
    Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE_BYTES
  );
}

/** Null means the SQLSTATE is unknown, and the caller reports it as a defect. */
export function actionCodeForSqlstate(sqlstate: string): ActionErrorCode | null {
  return SQLSTATE_TO_ACTION_CODE[sqlstate] ?? null;
}
