"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AnalysisSnapshot } from "@/types/contracts";
import { getAnalysisAction } from "../application/analysis.actions";

export function AnalysisStatusView({ initial }: { initial: AnalysisSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  async function refreshStatus() {
    setIsRefreshing(true);
    try {
      const result = await getAnalysisAction(snapshot.analysisId);
      if (result.ok) {
        setSnapshot(result.data);
        setMessage(null);
      } else setMessage(result.error.message);
    } catch {
      setMessage("Status refresh is temporarily unavailable.");
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    if (initial.status === "completed" || initial.status === "failed") return;
    let active = true;
    let attempts = 0;
    const timer = window.setInterval(async () => {
      attempts += 1;
      try {
        const result = await getAnalysisAction(initial.analysisId);
        if (!active) return;
        if (result.ok) {
          setSnapshot(result.data);
          if (result.data.status === "completed" || result.data.status === "failed") window.clearInterval(timer);
        } else {
          setMessage(result.error.message);
          window.clearInterval(timer);
        }
      } catch {
        if (active) setMessage("Status refresh is temporarily unavailable.");
      }
      if (attempts >= 60) window.clearInterval(timer);
    }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [initial.analysisId, initial.status]);

  const label = snapshot.status === "queued" ? "Queued" : snapshot.status === "processing" ? "Processing" : snapshot.status === "completed" ? "Completed" : "Failed";
  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-sm font-semibold uppercase tracking-wide text-cyan-800">Analysis status</p>
      <h1 className="mt-2 text-3xl font-semibold">{label}</h1>
      <p className="mt-2 text-sm text-slate-600">Analysis ID: <code>{snapshot.analysisId}</code></p>
      <button type="button" onClick={() => void refreshStatus()} disabled={isRefreshing} className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50">{isRefreshing ? "Refreshing…" : "Refresh status"}</button>
      <p className="mt-1 text-sm text-slate-600">Estimated cost: {snapshot.fixedCost} credits</p>
      <p className="mt-1 text-sm text-slate-600">Started by {snapshot.initiator.fullName} · Created {new Date(snapshot.createdAt).toLocaleString("en-US")}{snapshot.startedAt ? ` · Started ${new Date(snapshot.startedAt).toLocaleString("en-US")}` : ""}{snapshot.finishedAt ? ` · Finished ${new Date(snapshot.finishedAt).toLocaleString("en-US")}` : ""}</p>
      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4"><h2 className="font-semibold">Documents to analyze</h2><ul className="mt-2 space-y-1 text-sm text-slate-700">{snapshot.sources.map((item) => <li key={item.versionId}>{item.name} <span className="text-slate-500">v{item.versionNumber}</span></li>)}</ul></div>
        <div className="rounded-lg border border-slate-200 bg-white p-4"><h2 className="font-semibold">Compare against</h2>{snapshot.comparisons.length ? <ul className="mt-2 space-y-1 text-sm text-slate-700">{snapshot.comparisons.map((item) => <li key={item.versionId}>{item.name} <span className="text-slate-500">v{item.versionNumber}</span></li>)}</ul> : <p className="mt-2 text-sm text-slate-600">Internal contradiction analysis only.</p>}</div>
      </section>
      {snapshot.status === "queued" || snapshot.status === "processing" ? <p role="status" className="mt-5 rounded-lg bg-cyan-50 p-4 text-sm text-cyan-950">Your analysis is running. This page refreshes its status automatically.</p> : null}
      {snapshot.status === "failed" ? <p role="alert" className="mt-5 rounded-lg bg-amber-50 p-4 text-sm text-amber-950">{snapshot.error?.message ?? "The analysis failed."}</p> : null}
      {snapshot.status === "completed" ? <p className="mt-5 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-950">Analysis completed. Findings will be available when the findings experience is delivered.</p> : null}
      {message ? <p role="status" className="mt-3 text-sm text-slate-600">{message}</p> : null}
      {snapshot.status === "failed" ? <p className="mt-4 text-sm text-slate-600">Retry becomes available after the failed reservation has been released and verified.</p> : null}
      <Link className="mt-6 inline-block text-sm font-semibold text-cyan-800 underline" href="/analysis/run">Back to Run Analysis</Link>
    </div>
  );
}
