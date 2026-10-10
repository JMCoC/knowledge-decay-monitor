import { z } from "zod";

const categories = [
  "SOP",
  "Policy",
  "Manual",
  "QA Process",
  "Security",
  "Engineering Guideline",
  "Other",
] as const;

const versionStatuses = ["active", "historical", "pending_approval", "rejected"] as const;

export const repositoryQuerySchema = z.strictObject({
  name: z.string().trim().max(200).optional(),
  category: z.enum(categories).optional(),
  ownerId: z.union([z.string().uuid(), z.null()]).optional(),
  versionStatus: z.union([z.enum(versionStatuses), z.null()]).optional(),
  page: z.int().min(1).optional(),
  pageSize: z.int().min(1).max(100).optional(),
}).superRefine((query, context) => {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset > 2_147_483_647) {
    context.addIssue({
      code: "custom",
      path: ["page"],
      message: "The requested page is outside the supported range.",
    });
  }
}).transform((query) => ({
  ...query,
  page: query.page ?? 1,
  pageSize: query.pageSize ?? 25,
}));
