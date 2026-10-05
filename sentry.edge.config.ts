// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import {
  createTelemetrySentryOptions,
  resolveRuntimeTelemetryConfig,
} from "./src/lib/observability/config";
import { installSafeTransport } from "./src/lib/observability/safe-transport";

const telemetry = resolveRuntimeTelemetryConfig("edge");
Sentry.init({
  dsn: "https://e787d2e6093c40fc84e0f97f1b63ac43@o4512126143365120.ingest.us.sentry.io/4512126173380608",
  ...createTelemetrySentryOptions(telemetry),
});

if (telemetry.enabled && telemetry.context) {
  const installed = installSafeTransport(Sentry.getClient(), telemetry.context);
  if (!installed) void Sentry.close(0).catch(() => false);
}
