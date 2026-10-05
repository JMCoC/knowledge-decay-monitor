"use client";

import * as Sentry from "@sentry/nextjs";
import { useState } from "react";
import { captureSafeFailure } from "../../lib/observability/capture";
import { isDiagnosticExpiryActive } from "../../lib/observability/diagnostics-policy";
import { authorizeDiagnostics, runServerDiagnostic } from "./actions";

type DiagnosticReceipt = {
  correlationId: string;
  eventId?: string;
  flushed: boolean;
};

export default function DiagnosticsPanel({ expiresAt }: { expiresAt: string }) {
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<DiagnosticReceipt | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submitBrowserDiagnostic() {
    setPending(true);
    setReceipt(null);
    setMessage(null);
    try {
      const authorization = await authorizeDiagnostics();
      if (
        !authorization.ok ||
        !isDiagnosticExpiryActive(expiresAt, Date.now()) ||
        !isDiagnosticExpiryActive(authorization.data?.expiresAt ?? "", Date.now())
      ) {
        setMessage("Diagnostic access is no longer available. Refresh the page and sign in again.");
        return;
      }

      const captured = captureSafeFailure({
        module: "application",
        operation: "diagnostic",
        code: "INTERNAL_ERROR",
        synthetic: true,
      });
      if (!captured) {
        setMessage("We couldn't submit the diagnostic. Try again.");
        return;
      }

      let flushed = false;
      try {
        flushed = await Sentry.flush(2000);
      } catch {
        flushed = false;
      }
      setReceipt({ ...captured, flushed });
      setMessage("Submitted for verification.");
    } catch {
      setMessage("We couldn't submit the diagnostic. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function submitServerDiagnostic() {
    setPending(true);
    setReceipt(null);
    setMessage(null);
    try {
      const result = await runServerDiagnostic();
      if (!result.ok) {
        setMessage("Diagnostic access is no longer available. Refresh the page and sign in again.");
        return;
      }
      setReceipt(result.data);
      setMessage("Submitted for verification.");
    } catch {
      setMessage("We couldn't submit the diagnostic. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Sentry reporting diagnostics" className="flex flex-col gap-4">
      <p>These temporary checks submit fixed synthetic events and do not access product data.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={pending} onClick={submitBrowserDiagnostic}>
          Test browser reporting
        </button>
        <button type="button" disabled={pending} onClick={submitServerDiagnostic}>
          Test server reporting
        </button>
      </div>
      {message ? <p role="status" aria-live="polite">{message}</p> : null}
      {receipt ? (
        <dl>
          <dt>Correlation reference</dt>
          <dd>{receipt.correlationId}</dd>
          {receipt.eventId ? (
            <>
              <dt>Sentry event ID</dt>
              <dd>{receipt.eventId}</dd>
            </>
          ) : null}
          <dt>Queue flush</dt>
          <dd>{receipt.flushed ? "Completed" : "Not confirmed"}</dd>
        </dl>
      ) : null}
    </section>
  );
}
