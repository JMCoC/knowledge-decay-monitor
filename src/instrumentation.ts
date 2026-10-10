import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";
import { captureUnexpectedError } from "./lib/observability/unexpected-error";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error) => {
  captureUnexpectedError(error, "request");
  await Sentry.flush(2000).catch(() => false);
};
