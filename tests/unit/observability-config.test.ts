import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetrySentryOptions,
  resolveTelemetryConfig,
  resolveRuntimeTelemetryConfig,
  type TelemetryConfigInput,
} from "../../src/lib/observability/config";

const base: TelemetryConfigInput = {
  release: "a".repeat(40),
  disabled: false,
  localEnabled: false,
  test: false,
  runtime: "browser",
};

describe("Sentry deployment configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["preview", "vercel-preview"],
    ["production", "vercel-production"],
  ] as const)("maps the %s target to its explicit environment", (target, environment) => {
    expect(resolveTelemetryConfig({ ...base, target })).toMatchObject({
      enabled: true,
      context: { environment, release: base.release, runtime: "browser" },
    });
  });

  it("keeps development disabled unless local sending is opted in", () => {
    expect(resolveTelemetryConfig(base)).toEqual({ enabled: false, context: null });
    expect(
      resolveTelemetryConfig({ ...base, localEnabled: true, target: "development" }),
    ).toEqual({
      enabled: true,
      context: {
        environment: "development",
        release: base.release,
        runtime: "browser",
      },
    });
  });

  it("allows a dirty SHA only for opted-in local development", () => {
    const dirtyRelease = `${"a".repeat(40)}-dirty`;

    expect(
      resolveTelemetryConfig({ ...base, target: "development", release: dirtyRelease, localEnabled: true }).enabled,
    ).toBe(true);
    expect(
      resolveTelemetryConfig({ ...base, target: "preview", release: dirtyRelease }),
    ).toEqual({ enabled: false, context: null });
  });

  it("fails closed for an unknown target or malformed release", () => {
    expect(resolveTelemetryConfig({ ...base, target: "staging" })).toEqual({
      enabled: false,
      context: null,
    });
    expect(resolveTelemetryConfig({ ...base, target: "preview", release: "bad" })).toEqual({
      enabled: false,
      context: null,
    });
    expect(resolveTelemetryConfig({ ...base, target: "production", release: undefined })).toEqual({
      enabled: false,
      context: null,
    });
  });

  it("gives the kill switch and test mode priority over every opt-in", () => {
    expect(
      resolveTelemetryConfig({
        ...base,
        target: "development",
        localEnabled: true,
        disabled: true,
      }).enabled,
    ).toBe(false);
    expect(
      resolveTelemetryConfig({ ...base, target: "production", test: true }).enabled,
    ).toBe(false);
  });

  it("keeps Sentry disabled in Vitest even when local environment variables opt in", () => {
    vi.stubEnv("NEXT_PUBLIC_KDM_SENTRY_TARGET", "development");
    vi.stubEnv("NEXT_PUBLIC_KDM_RELEASE", "a".repeat(40));
    vi.stubEnv("NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_KDM_DISABLE_SENTRY", "0");
    vi.stubEnv("KDM_DISABLE_SENTRY", "0");

    expect(resolveRuntimeTelemetryConfig("browser")).toEqual({
      enabled: false,
      context: null,
    });
  });

  it("builds restrictive options and drops events when no trusted context exists", () => {
    const options = createTelemetrySentryOptions({ enabled: false, context: null });

    expect(options).toMatchObject({
      enabled: false,
      defaultIntegrations: false,
      attachStacktrace: false,
      sendDefaultPii: false,
      sendClientReports: false,
      enableLogs: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
    expect(options.beforeSend({ message: "MUST_NOT_BE_SENT" } as never)).toBeNull();
  });
});
