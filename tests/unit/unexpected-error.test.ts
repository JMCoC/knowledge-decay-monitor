import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
  captureSafeFailure: vi.fn(() => ({ correlationId: "d2131057-f063-4b12-bafe-746728e8d7ad" })),
}));

vi.mock("../../src/lib/observability/capture", () => capture);

import { notFound, redirect } from "next/navigation";
import {
  captureUnexpectedError,
  registerBrowserErrorHandlers,
} from "../../src/lib/observability/unexpected-error";

describe("unexpected error capture", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captures the same error object once without passing its payload", () => {
    const error = new Error("SECRET_SENTINEL");

    captureUnexpectedError(error, "render");
    captureUnexpectedError(error, "render");

    expect(capture.captureSafeFailure).toHaveBeenCalledTimes(1);
    expect(capture.captureSafeFailure).toHaveBeenCalledWith({
      module: "application",
      operation: "render",
      code: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(capture.captureSafeFailure.mock.calls)).not.toContain("SECRET_SENTINEL");
  });

  it("handles primitive rejection reasons without forwarding their value", () => {
    captureUnexpectedError("REJECTION_SENTINEL", "unhandled");

    expect(capture.captureSafeFailure).toHaveBeenCalledWith({
      module: "application",
      operation: "unhandled",
      code: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(capture.captureSafeFailure.mock.calls)).not.toContain("REJECTION_SENTINEL");
  });

  it.each([
    ["redirect", () => redirect("/login")],
    ["notFound", () => notFound()],
  ])("leaves Next.js %s control flow to the framework", (_name, controlFlow) => {
    let controlError: unknown;
    try {
      controlFlow();
    } catch (error) {
      controlError = error;
    }

    expect(captureUnexpectedError(controlError, "request")).toBeUndefined();
    expect(capture.captureSafeFailure).not.toHaveBeenCalled();
  });

  it("does not suppress unrelated errors just because they have a digest", () => {
    const error = Object.assign(new Error("PRIVATE_SENTINEL"), { digest: "arbitrary-value" });

    captureUnexpectedError(error, "request");

    expect(capture.captureSafeFailure).toHaveBeenCalledWith({
      module: "application",
      operation: "request",
      code: "INTERNAL_ERROR",
    });
  });

  it("registers one browser listener pair and reads only error or rejection reason", () => {
    const target = new EventTarget();
    registerBrowserErrorHandlers(target);
    registerBrowserErrorHandlers(target);

    const error = new Event("error");
    Object.defineProperties(error, {
      error: { value: new Error("WINDOW_ERROR_SENTINEL") },
      message: { value: "MESSAGE_SENTINEL" },
      filename: { value: "PRIVATE_PATH_SENTINEL" },
    });
    target.dispatchEvent(error);

    const rejection = new Event("unhandledrejection");
    Object.defineProperties(rejection, {
      reason: { value: "REJECTION_SENTINEL" },
      promise: { value: Promise.resolve() },
    });
    target.dispatchEvent(rejection);

    expect(capture.captureSafeFailure).toHaveBeenCalledTimes(2);
    expect(capture.captureSafeFailure).toHaveBeenNthCalledWith(1, {
      module: "application",
      operation: "unhandled",
      code: "INTERNAL_ERROR",
    });
    expect(capture.captureSafeFailure).toHaveBeenNthCalledWith(2, {
      module: "application",
      operation: "unhandled",
      code: "INTERNAL_ERROR",
    });
    expect(JSON.stringify(capture.captureSafeFailure.mock.calls)).not.toMatch(/SENTINEL|PRIVATE_PATH/);
  });
});
