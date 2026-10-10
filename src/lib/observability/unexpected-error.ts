import { unstable_rethrow } from "next/navigation";
import { captureSafeFailure } from "./capture";
import type { CaptureReceipt } from "./safe-event";

export type UnexpectedOperation = "request" | "render" | "unhandled";

const capturedObjects = new WeakMap<object, CaptureReceipt | undefined>();
const registeredTargets = new WeakSet<EventTarget>();

function isObjectReference(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isNextControlFlow(error: unknown): boolean {
  try {
    unstable_rethrow(error);
    return false;
  } catch (rethrown) {
    return rethrown === error;
  }
}

/** Records a fixed application failure without serializing or retaining the thrown value. */
export function captureUnexpectedError(
  error: unknown,
  operation: UnexpectedOperation,
): CaptureReceipt | undefined {
  if (isNextControlFlow(error)) return undefined;

  if (isObjectReference(error)) {
    if (capturedObjects.has(error)) return capturedObjects.get(error);
    capturedObjects.set(error, undefined);
  }

  try {
    const receipt = captureSafeFailure({
      module: "application",
      operation,
      code: "INTERNAL_ERROR",
    });
    if (isObjectReference(error)) capturedObjects.set(error, receipt);
    return receipt;
  } catch {
    return undefined;
  }
}

/** Installs one redacted browser handler pair; event metadata never becomes telemetry. */
export function registerBrowserErrorHandlers(target: EventTarget = window): void {
  if (registeredTargets.has(target)) return;

  try {
    target.addEventListener("error", (event) => {
      const error = (event as ErrorEvent).error;
      if (error !== undefined && error !== null) captureUnexpectedError(error, "unhandled");
    });
    target.addEventListener("unhandledrejection", (event) => {
      captureUnexpectedError((event as PromiseRejectionEvent).reason, "unhandled");
    });
    registeredTargets.add(target);
  } catch {
    // Instrumentation must not change browser behavior.
  }
}
