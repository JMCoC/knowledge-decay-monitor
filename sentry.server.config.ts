// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { authSafeSentryOptions } from "./src/lib/observability/auth-events";

Sentry.init({
  dsn: "https://e787d2e6093c40fc84e0f97f1b63ac43@o4512126143365120.ingest.us.sentry.io/4512126173380608",
  enabled: process.env.NODE_ENV === "production" && process.env.KDM_DISABLE_SENTRY !== "1",
  ...authSafeSentryOptions,
});
