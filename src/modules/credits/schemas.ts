import { z } from "zod";

const safeNonNegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const creditLedgerQuerySchema = z.object({
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
}).strict();

export const creditSnapshotSchema = z.object({
  available: safeNonNegative,
  reserved: safeNonNegative,
}).strict();

export const creditLedgerPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    type: z.enum(["Promotional", "Reserved", "Consumed", "Released"]),
    amount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    analysisId: z.string().uuid().nullable(),
    createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  }).strict()),
  total: safeNonNegative,
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  pageSize: z.number().int().min(1).max(100),
}).strict();
