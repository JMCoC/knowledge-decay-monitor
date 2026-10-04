import { repositoryQuerySchema } from "../schemas";
import type { RepositoryQuery } from "@/types/contracts";

export type RepositorySearchParams = Record<string, string | string[] | undefined>;

/** Parses URL input one field at a time; malformed or repeated values are ignored safely. */
export function parseRepositorySearchParams(params: RepositorySearchParams): RepositoryQuery {
  const single = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : undefined;
  };

  const raw: Record<string, unknown> = {};
  const name = single("name");
  const category = single("category");
  const ownerId = single("ownerId");
  const versionStatus = single("versionStatus");
  const page = single("page");
  const pageSize = single("pageSize");

  if (name !== undefined) raw.name = name;
  if (category !== undefined) raw.category = category;
  if (ownerId === "unassigned") raw.ownerId = null;
  else if (ownerId !== undefined) raw.ownerId = ownerId;
  if (versionStatus === "not_active") raw.versionStatus = null;
  else if (versionStatus !== undefined) raw.versionStatus = versionStatus;
  if (page !== undefined && /^\d+$/.test(page)) raw.page = Number(page);
  if (pageSize !== undefined && /^\d+$/.test(pageSize)) raw.pageSize = Number(pageSize);

  const parsed = repositoryQuerySchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // Drop only invalid filters, preserving independent valid filters and safe defaults.
  for (const key of ["name", "category", "ownerId", "versionStatus", "page", "pageSize"]) {
    const candidate = { ...raw };
    delete candidate[key];
    if (repositoryQuerySchema.safeParse(candidate).success) {
      const repaired = repositoryQuerySchema.safeParse({ ...candidate });
      if (repaired.success) return repaired.data;
    }
  }

  const safeName = typeof name === "string" ? name.trim().slice(0, 200) : undefined;
  const safePage = typeof raw.page === "number" && Number.isSafeInteger(raw.page) && raw.page > 0 ? raw.page : 1;
  const safePageSize = typeof raw.pageSize === "number" && raw.pageSize >= 1 && raw.pageSize <= 100 ? raw.pageSize : 25;
  return repositoryQuerySchema.parse({ ...(safeName ? { name: safeName } : {}), page: safePage, pageSize: safePageSize });
}

export function hasRepositoryFilters(query: RepositoryQuery): boolean {
  return Boolean(query.name || query.category || query.ownerId !== undefined || query.versionStatus !== undefined);
}
