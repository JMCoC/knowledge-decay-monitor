"use server";

import type { ActionResult } from "../../types/contracts";
import {
  authorizeDiagnosticRequest,
  emitServerDiagnostic,
} from "../../lib/observability/diagnostics.server";

export async function authorizeDiagnostics(): Promise<ActionResult<{ expiresAt: string }>> {
  return authorizeDiagnosticRequest();
}

export async function runServerDiagnostic(): Promise<
  ActionResult<{ correlationId: string; eventId?: string; flushed: boolean }>
> {
  return emitServerDiagnostic();
}
