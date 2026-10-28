"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AnalysisEstimate, AnalysisSnapshot } from "@/types/contracts";
import { estimateAnalysisAction, getAnalysisAction } from "../application/analysis.actions";
import { retryAnalysis } from "../application/run-actions";
import { useRouter } from "next/navigation";

export function AnalysisStatusView({ initial }: { initial: AnalysisSnapshot }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [retryEstimate, setRetryEstimate] = useState<AnalysisEstimate | null>(null);
  const [isEstimatingRetry, setIsEstimatingRetry] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryConfirmation, setRetryConfirmation] = useState(false);
  const retryKey = useRef<string | null>(null);

  async function estimateRetry() {
    setMessage(null);
    setIsEstimatingRetry(true);
    try {
      const result = await estimateAnalysisAction({
        sourceVersionIds: snapshot.sources.map((item) => item.versionId),
        comparisonVersionIds: snapshot.comparisons.map((item) => item.versionId),
      });
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setRetryEstimate(result.data);
      setRetryConfirmation(true);
    } catch {
      setMessage("We couldn't estimate this retry. Please try again.");
    } finally {
      setIsEstimatingRetry(false);
    }
  }

  async function confirmRetry() {
    if (!retryEstimate || !snapshot.canRetry) return;
    retryKey.current ??= crypto.randomUUID();
    try {
      window.sessionStorage.setItem("pending-analysis-retry", JSON.stringify({
        failedAnalysisId: snapshot.analysisId,
        estimateRef: retryEstimate.estimateRef,
        idempotencyKey: retryKey.current,
      }));
    } catch { /* Keep the retry key in memory if storage is unavailable. */ }
    setIsRetrying(true);
    setMessage(null);
    try {
      const result = await retryAnalysis({
        failedAnalysisId: snapshot.analysisId,
        estimateRef: retryEstimate.estimateRef,
        idempotencyKey: retryKey.current,
      });
      if (!result.ok) {
        setMessage(result.error.message);
        setRetryKey(null);
        try { window.sessionStorage.removeItem("pending-analysis-retry"); } catch { /* Storage may be unavailable. */ }
        if (result.error.code === "ESTIMATE_EXPIRED" || result.error.code === "ESTIMATE_STALE") setRetryEstimate(null);
        return;
      }
      try { window.sessionStorage.removeItem("pending-analysis-retry"); } catch { /* Storage may be unavailable. */ }
      router.push(`/analysis/${result.data.analysisId}`);
    } catch {
      setMessage("We couldn't confirm whether the retry started. Retry this confirmation to safely recover it.");
    } finally {
      setIsRetrying(false);
    }
  }

  function setRetryKey(value: string | null) {
    retryKey.current = value;
  }

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
    if (initial.status === "failed") {
      let active = true;
      try {
        const raw = window.sessionStorage.getItem("pending-analysis-retry");
        const pending = raw ? JSON.parse(raw) as { failedAnalysisId?: unknown; estimateRef?: unknown; idempotencyKey?: unknown } : null;
        if (pending?.failedAnalysisId === initial.analysisId && typeof pending.estimateRef === "string" && typeof pending.idempotencyKey === "string") {
          void retryAnalysis({ failedAnalysisId: initial.analysisId, estimateRef: pending.estimateRef, idempotencyKey: pending.idempotencyKey }).then((result) => {
            if (active && result.ok) {
              window.sessionStorage.removeItem("pending-analysis-retry");
              router.replace(`/analysis/${result.data.analysisId}`);
            } else if (active && !result.ok) {
              window.sessionStorage.removeItem("pending-analysis-retry");
            }
          }).catch(() => undefined);
        }
      } catch { /* Session storage may be disabled or contain invalid data. */ }
      return () => { active = false; };
    }
    if (initial.status === "completed") return;
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
  }, [initial.analysisId, initial.status, router]);

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
      {snapshot.status === "failed" ? (snapshot.canRetry ? <button type="button" disabled={isEstimatingRetry || isRetrying} onClick={() => void estimateRetry()} className="mt-4 rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{isEstimatingRetry ? "Estimating retry…" : "Retry Analysis"}</button> : <p className="mt-4 text-sm text-slate-600">Retry is unavailable until the failed reservation has been released.</p>) : null}
      {retryConfirmation && retryEstimate ? <div role="dialog" aria-modal="true" aria-labelledby="retry-confirmation-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><section className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"><h2 id="retry-confirmation-title" className="text-lg font-semibold">Confirm analysis retry</h2><p className="mt-3 text-sm text-slate-700">Estimated cost: {retryEstimate.fixedCost} credits</p><div className="mt-6 flex justify-end gap-3"><button type="button" disabled={isRetrying} onClick={() => setRetryConfirmation(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">Cancel</button><button type="button" disabled={isRetrying} onClick={() => void confirmRetry()} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{isRetrying ? "Starting…" : "Confirm and retry"}</button></div></section></div> : null}
      <Link className="mt-6 inline-block text-sm font-semibold text-cyan-800 underline" href="/analysis/run">Back to Run Analysis</Link>
    </div>
  );
}
