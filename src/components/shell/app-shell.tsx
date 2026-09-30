"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { WorkspaceRole } from "../../types/contracts";
import { logout } from "../../modules/identity/actions";

type AppShellProps = {
  workspaceName: string;
  fullName: string;
  role: WorkspaceRole;
  children: React.ReactNode;
};

export function AppShell({ workspaceName, fullName, role, children }: AppShellProps) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canSeeRepository = role === "Admin" || role === "QA Lead";

  async function handleSignOut() {
    setMessage(null);
    setPending(true);
    try {
      const result = await logout();
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      router.replace(result.data.destination);
      router.refresh();
    } catch {
      setMessage("We couldn't sign you out. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/app" className="font-semibold tracking-tight text-cyan-950">
            Knowledge Decay Monitor
          </Link>
          <div className="flex min-w-0 items-center gap-3 sm:gap-5">
            <div className="hidden min-w-0 text-right sm:block">
              <p className="truncate text-sm font-medium text-slate-900">{workspaceName}</p>
              <p className="truncate text-xs text-slate-500">{fullName}</p>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={pending}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-900 disabled:opacity-60"
            >
              {pending ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav
          aria-label="Main navigation"
          className="flex gap-2 overflow-x-auto border-b border-slate-200 bg-white px-4 py-3 lg:min-h-[calc(100vh-73px)] lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r lg:px-5 lg:py-8"
        >
          <Link
            href="/app"
            aria-current="page"
            className="shrink-0 rounded-lg bg-cyan-50 px-3 py-2 text-sm font-semibold text-cyan-950"
          >
            Home
          </Link>
          {canSeeRepository ? (
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="shrink-0 cursor-not-allowed rounded-lg px-3 py-2 text-left text-sm text-slate-400"
              title="Repository will be available in a later release."
            >
              Repository
            </button>
          ) : null}
        </nav>

        <main className="min-w-0 px-4 py-8 sm:px-6 lg:px-10 lg:py-10">
          {message ? (
            <p role="alert" className="mb-6 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {message}
            </p>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
