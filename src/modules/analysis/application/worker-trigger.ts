import "server-only";

import { after } from "next/server";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import { getServiceSupabaseConfig } from "@/lib/supabase/service";

function reportTriggerFailure(): void {
  try {
    captureOperationFailure({
      module: "analysis",
      operation: "trigger",
      code: "INTERNAL_ERROR",
      correlationId: crypto.randomUUID(),
    });
  } catch {
    // Trigger observability cannot change a committed command result.
  }
}

async function invokeAnalysisWorker(analysisId: string): Promise<void> {
  const token = process.env.ANALYSIS_INTERNAL_TOKEN;
  if (!token) {
    reportTriggerFailure();
    return;
  }

  try {
    const { url } = getServiceSupabaseConfig();
    const endpoint = new URL("/functions/v1/analyze", url.origin);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ analysisId }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) reportTriggerFailure();
  } catch {
    // Do not serialize fetch errors, response bodies, URLs, tokens, or payloads.
    reportTriggerFailure();
  }
}

/** Registers a best-effort dispatch to run only after the Server Action response. */
export function scheduleAnalysisTrigger(analysisId: string): void {
  try {
    after(() => invokeAnalysisWorker(analysisId));
  } catch {
    // after() may be unavailable outside a request context; the DB queue remains durable.
    reportTriggerFailure();
  }
}
