import { getIdentityContext } from "@/modules/identity/session";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { getCreditSnapshot, listCreditLedger } from "@/modules/credits";
import { OperationError } from "@/components/operation-error";
import Link from "next/link";

export const runtime = "nodejs";

export default async function CreditsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const params = await searchParams;
  const parsedPage = Number(params.page ?? "1");
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const [snapshot, context] = await Promise.all([
    getCreditSnapshot(),
    getIdentityContext(await createReadOnlyClient()),
  ]);
  if (!snapshot.ok) return <OperationError error={snapshot.error} />;
  const canViewLedger = context.state === "ready" && (context.actor.role === "Admin" || context.actor.role === "QA Lead");
  const ledger = canViewLedger ? await listCreditLedger({ page, pageSize: 25 }) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-semibold text-slate-900">Billing / Credits</h1>
      <p className="mt-1 text-sm text-slate-600">Workspace credit balance and recent activity.</p>
      <section aria-label="Credit balance" className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">Available</p><p className="mt-2 text-3xl font-semibold">{snapshot.data.available}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">Reserved</p><p className="mt-2 text-3xl font-semibold">{snapshot.data.reserved}</p></div>
      </section>
      {canViewLedger ? (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">Recent credit activity</h2>
          {ledger && !ledger.ok ? <div className="mt-4"><OperationError error={ledger.error} /></div> : null}
          {ledger?.ok ? <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-600"><tr><th className="px-4 py-3">Event</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Analysis</th><th className="px-4 py-3">Date</th></tr></thead><tbody>{ledger.data.items.map((item) => <tr key={item.id} className="border-t border-slate-100"><td className="px-4 py-3">{item.type}</td><td className="px-4 py-3">{item.amount}</td><td className="px-4 py-3">{item.analysisId ?? "—"}</td><td className="px-4 py-3">{new Date(item.createdAt).toLocaleString("en-US")}</td></tr>)}</tbody></table><div className="flex items-center justify-between px-4 py-3 text-sm"><span className="text-slate-500">Page {ledger.data.page} · {ledger.data.total} events</span><div className="flex gap-3">{page > 1 ? <Link href={`/credits?page=${page - 1}`} className="font-medium text-cyan-800 underline">Previous</Link> : <span className="text-slate-400">Previous</span>}{page * ledger.data.pageSize < ledger.data.total ? <Link href={`/credits?page=${page + 1}`} className="font-medium text-cyan-800 underline">Next</Link> : <span className="text-slate-400">Next</span>}</div></div></div> : null}
        </section>
      ) : null}
    </div>
  );
}
