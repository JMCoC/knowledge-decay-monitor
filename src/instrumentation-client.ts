// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import {
  createTelemetrySentryOptions,
  resolveRuntimeTelemetryConfig,
} from "./lib/observability/config";
import { installSafeTransport } from "./lib/observability/safe-transport";
import { registerBrowserErrorHandlers } from "./lib/observability/unexpected-error";

const telemetry = resolveRuntimeTelemetryConfig("browser");
const client = Sentry.init({
  dsn: "https://e787d2e6093c40fc84e0f97f1b63ac43@o4512126143365120.ingest.us.sentry.io/4512126173380608",
  ...createTelemetrySentryOptions(telemetry),
});

if (telemetry.enabled && telemetry.context) {
  const installed = installSafeTransport(client ?? Sentry.getClient(), telemetry.context);
  if (!installed) void Sentry.close(0).catch(() => false);
}

registerBrowserErrorHandlers(window);
