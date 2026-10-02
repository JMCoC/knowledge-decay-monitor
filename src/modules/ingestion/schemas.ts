import { z } from "zod";
import type { DocumentCategory, UploadItemInput } from "@/types/contracts";
import {
  decodeSignature,
  extensionFromFileName,
  isDeclaredMimeConsistent,
  isSignatureConsistent,
  isValidFileSize,
  MAX_FILE_SIZE_BYTES,
} from "./validation";

export const MAX_BATCH_ITEMS = 10;

/** Same seven values as the public.document_category enum. */
const DOCUMENT_CATEGORIES = [
  "SOP",
  "Policy",
  "Manual",
  "QA Process",
  "Security",
  "Engineering Guideline",
  "Other",
] as const satisfies readonly DocumentCategory[];

const uploadMetadataSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(DOCUMENT_CATEGORIES),
  ownerId: z.string().uuid(),
});

const sizeSchema = z.number().refine(isValidFileSize, {
  message: `A file must be between 1 byte and ${MAX_FILE_SIZE_BYTES} bytes.`,
});

const signatureSchema = z.string().refine((value) => decodeSignature(value) !== null, {
  message: "The signature must be the first 8 bytes of the file, base64 encoded.",
});

/**
 * One message per rule, evaluated by three independent refinements rather than
 * one `superRefine`: `superRefine` is deprecated in Zod 4, and each `refine`
 * carries its own message instead of a `path` the action would have to map.
 */
export const uploadItemSchema = z
  .object({
    metadata: uploadMetadataSchema,
    fileName: z.string().min(1).max(255),
    declaredMimeType: z.string().min(1).max(128),
    sizeBytes: sizeSchema,
    signature: signatureSchema,
  })
  .refine((item) => extensionFromFileName(item.fileName) !== null, {
    message: "Only PDF, DOCX and Markdown files are accepted.",
  })
  .refine(
    (item) => {
      const extension = extensionFromFileName(item.fileName);
      return extension === null || isDeclaredMimeConsistent(extension, item.declaredMimeType);
    },
    { message: "The declared type does not match the file extension." },
  )
  .refine(
    (item) => {
      const extension = extensionFromFileName(item.fileName);
      const bytes = decodeSignature(item.signature);
      if (extension === null || bytes === null) {
        return true;
      }
      return isSignatureConsistent(extension, bytes);
    },
    { message: "The file contents do not match the file extension." },
  ) satisfies z.ZodType<UploadItemInput>;

/**
 * The envelope only. Entries stay `unknown` on purpose: validating them here
 * would make one bad file reject the whole batch and leave
 * `UploadItemResult.index` with nothing to point at.
 */
export const uploadBatchSchema = z.array(z.unknown()).min(1).max(MAX_BATCH_ITEMS);

export const finalizeBatchSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(MAX_BATCH_ITEMS)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "A version can only be finalized once per call.",
  });
