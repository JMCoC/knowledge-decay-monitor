"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DocumentCategory, EligibleOwner, VersionStatus } from "@/types/contracts";

const categories: DocumentCategory[] = ["SOP", "Policy", "Manual", "QA Process", "Security", "Engineering Guideline", "Other"];
const statuses: { value: VersionStatus | "not_active"; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "historical", label: "Historical" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "rejected", label: "Rejected" },
  { value: "not_active", label: "Processing / Not active" },
];

export function RepositoryFilters({ owners }: { owners: EligibleOwner[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlName = searchParams.get("name") ?? "";
  const [draft, setDraft] = useState({ query: urlName, name: urlName });
  const name = draft.query === urlName ? draft.name : urlName;
  const nameIsDirty = draft.query === urlName && draft.name !== urlName;
  const [isPending, startTransition] = useTransition();
  const currentQuery = searchParams.toString();
  const hasFilters = ["name", "category", "ownerId", "versionStatus"].some((key) => searchParams.has(key));

  const update = useCallback((key: string, value: string, debounce = false) => {
    const params = new URLSearchParams(currentQuery);
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    const query = params.toString();
    const navigate = () => startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
    if (debounce) {
      const timeout = window.setTimeout(navigate, 300);
      return () => window.clearTimeout(timeout);
    }
    navigate();
    return undefined;
  }, [currentQuery, pathname, router]);

  useEffect(() => {
    if (!nameIsDirty) return;
    return update("name", name.trim(), true);
  }, [name, nameIsDirty, update]);

  const clear = () => {
    setDraft({ query: urlName, name: "" });
    router.replace(pathname, { scroll: false });
  };

  return (
    <section aria-label="Repository filters" className="mt-6 rounded-lg border bg-white p-4">
      <div className="grid gap-3 md:grid-cols-4">
        <div>
          <label htmlFor="filter-name" className="text-sm font-medium text-zinc-700">Search by name</label>
          <span className="mt-1 flex gap-2">
            <input id="filter-name" aria-label="Search by name" value={name} onChange={(event) => setDraft({ query: urlName, name: event.target.value })} maxLength={200} placeholder="Search documents" className="min-w-0 flex-1 rounded-md border px-3 py-2 font-normal" />
            {name && <button type="button" onClick={() => setDraft({ query: urlName, name: "" })} aria-label="Clear search" className="rounded-md border px-3">×</button>}
          </span>
        </div>
        <div>
          <label htmlFor="filter-category" className="text-sm font-medium text-zinc-700">Category</label>
          <select id="filter-category" aria-label="Category" value={searchParams.get("category") ?? ""} onChange={(event) => update("category", event.target.value)} className="mt-1 block w-full rounded-md border bg-white px-3 py-2 font-normal">
            <option value="">All categories</option>{categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="filter-owner" className="text-sm font-medium text-zinc-700">Owner</label>
          <select id="filter-owner" aria-label="Owner" value={searchParams.get("ownerId") ?? ""} onChange={(event) => update("ownerId", event.target.value)} className="mt-1 block w-full rounded-md border bg-white px-3 py-2 font-normal">
            <option value="">All owners</option><option value="unassigned">Unassigned</option>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.fullName}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="filter-version-state" className="text-sm font-medium text-zinc-700">Version state</label>
          <select id="filter-version-state" aria-label="Version state" value={searchParams.get("versionStatus") ?? ""} onChange={(event) => update("versionStatus", event.target.value)} className="mt-1 block w-full rounded-md border bg-white px-3 py-2 font-normal">
            <option value="">All statuses</option>{statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-zinc-500">
        <span aria-live="polite">{isPending ? "Updating results…" : " "}</span>
        {hasFilters && <button type="button" onClick={clear} className="font-medium text-blue-700 hover:underline">Clear filters</button>}
      </div>
    </section>
  );
}
