import * as Sentry from "@sentry/node";
import { randomUUID } from "node:crypto";
import { filterSafeEvent, type TelemetryContext } from "@/lib/observability/safe-event";

export function initWorkerTelemetry() {
  const environment=process.env.INGESTION_ENVIRONMENT ?? "development";
  const release=process.env.INGESTION_RELEASE_SHA ?? "0".repeat(40);
  if(!["development","vercel-preview","vercel-production"].includes(environment)
    || !/^[0-9a-f]{40}$/i.test(release)) throw new Error("Invalid worker telemetry configuration.");
  const context:TelemetryContext={environment:environment as TelemetryContext["environment"],release,runtime:"server"};
  Sentry.init({
    dsn:process.env.SENTRY_DSN,enabled:process.env.KDM_DISABLE_SENTRY!=="1" && Boolean(process.env.SENTRY_DSN),
    environment,release,defaultIntegrations:false,sendDefaultPii:false,sendClientReports:false,maxBreadcrumbs:0,
    beforeSend:(event)=>filterSafeEvent(event,context),beforeBreadcrumb:()=>null,
  });
}

/** Controlled manual event; raw exceptions are never passed to the SDK. */
export function reportWorkerFailure(versionId?:string,persistence=false) {
  Sentry.withScope((scope)=>{
    scope.setTags({"kdm.safe":"true",module:"ingestion",operation:"process",
      code:persistence?"PERSISTENCE_FAILED":"PROCESSING_FAILED",correlation_id:randomUUID(),runtime:"server",
      ...(versionId?{version_id:versionId}:{})});
    Sentry.captureMessage("Product operation failed","error");
  });
}

export async function flushWorkerTelemetry() {
  await Promise.race([Sentry.flush(500).catch(()=>false),new Promise((resolve)=>setTimeout(resolve,500))]);
}
