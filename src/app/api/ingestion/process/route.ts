import "server-only";

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/service";
import { captureOperationFailure } from "@/lib/observability/operation-events";
import { runProcessing } from "@/modules/ingestion/processing";

const bodySchema = z.strictObject({
  versionId: z.string().uuid(),
  operationId: z.string().uuid().optional(),
  operation: z.enum(["process", "retry"]).optional(),
}).refine((body) => {
  const operation = body.operation ?? "process";
  return operation === "retry" ? body.operationId !== undefined : body.operationId === undefined;
});

const GENERIC_FAILURE_MESSAGE = "Something went wrong. Try again.";

export const runtime = "nodejs";
export const maxDuration = 90;

function unauthorized(): Response {
  return new Response(null, { status: 401 });
}

function isAuthorized(header: string | null, expected: string): boolean {
  if (!header) return false;
  const received = Buffer.from(header, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch: unequal length is simply
  // unauthorized, never a crash.
  if (received.length !== wanted.length) return false;
  try {
    return timingSafeEqual(received, wanted);
  } catch {
    return false;
  }
}

/**
 * Claims a confirmed v1 upload or dispatches an already claimed retry. Empty
 * claims are 204 with no worker. Never logs the token, paths, or provider
 * details.
 */
export async function POST(request: Request): Promise<Response> {
  const expectedToken = process.env.INGESTION_INTERNAL_TOKEN;
  if (!expectedToken) {
    return Response.json({ error: GENERIC_FAILURE_MESSAGE }, { status: 500 });
  }
  if (!isAuthorized(request.headers.get("x-internal-token"), expectedToken)) {
    return unauthorized();
  }

  let versionId: string;
  let operationId: string | undefined;
  let operation: "process" | "retry";
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: GENERIC_FAILURE_MESSAGE }, { status: 400 });
    }
    versionId = parsed.data.versionId;
    operationId = parsed.data.operationId;
    operation = parsed.data.operation ?? "process";
  } catch {
    return Response.json({ error: GENERIC_FAILURE_MESSAGE }, { status: 400 });
  }

  const claimedOperationId = operationId ?? crypto.randomUUID();
  try {
    if (operation === "process") {
      const service = createServiceClient();
      const { data, error } = await service
        .from("document_versions")
        .update({
          processing_status: "processing",
          processing_operation_id: claimedOperationId,
          processing_started_at: new Date().toISOString(),
        })
        .eq("id", versionId)
        .eq("processing_status", "uploaded")
        .eq("upload_state", "confirmed")
        .eq("version_number", 1)
        .is("version_status", null)
        .select("processing_operation_id");
      if (error) throw error;
      if (!data?.some((row) => row.processing_operation_id === claimedOperationId)) {
        return new Response(null, { status: 204 });
      }
    }
    // Awaited on purpose: a fire-and-forget promise is frozen when a
    // serverless handler returns, which would strand the version in
    // `processing` every time (spec §10.3 as the default path). The caller
    // is `after()` from finalizeUpload, invisible to the user, and the
    // worker's internal timeout (50 s) fits under the platform timeout.
    try {
      if (operation === "retry") {
        await runProcessing(versionId, claimedOperationId, "retry");
      } else {
        await runProcessing(versionId, claimedOperationId);
      }
    } catch {
      // runProcessing swallows its own failures and marks
      // processing_failed; a throw here is a defect worth reporting.
      try {
        captureOperationFailure({
          module: "ingestion",
          operation,
          code: "PERSISTENCE_FAILED",
          correlationId: crypto.randomUUID(),
        });
      } catch {
        // Telemetry must not change the controlled product result.
      }
    }
    return Response.json({ status: "processing" }, { status: 200 });
  } catch {
    try {
      captureOperationFailure({
        module: "ingestion",
        operation,
        code: "PERSISTENCE_FAILED",
        correlationId: crypto.randomUUID(),
      });
    } catch {
      // Telemetry must not change the controlled product result.
    }
    return Response.json({ error: GENERIC_FAILURE_MESSAGE }, { status: 500 });
  }
}
