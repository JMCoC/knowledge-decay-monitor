import { z } from "zod";

const nameSchema = z.string().trim().refine(
  (value) => {
    const length = Array.from(value).length;
    return length >= 1 && length <= 120;
  },
  "Use between 1 and 120 characters.",
);

export const createWorkspaceSchema = z.strictObject({
  name: nameSchema,
  fullName: nameSchema,
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
