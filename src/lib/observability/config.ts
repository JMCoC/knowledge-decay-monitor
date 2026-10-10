import { filterSafeEvent, type TelemetryContext } from "./safe-event";

export type TelemetryConfigInput = {
  target?: string;
  release?: string;
  disabled: boolean;
  localEnabled: boolean;
  test: boolean;
  runtime: TelemetryContext["runtime"];
};

export type ResolvedTelemetryConfig = {
  enabled: boolean;
  context: TelemetryContext | null;
};

const releasePattern = /^[0-9a-f]{40}(?:-dirty)?$/i;

function disabledConfig(): ResolvedTelemetryConfig {
  return { enabled: false, context: null };
}

export function resolveTelemetryConfig(input: TelemetryConfigInput): ResolvedTelemetryConfig {
  if (input.disabled || input.test) return disabledConfig();

  const target = input.target ?? "development";
  const environment =
    target === "development"
      ? "development"
      : target === "preview"
        ? "vercel-preview"
        : target === "production"
          ? "vercel-production"
          : null;
  const release = input.release;

  if (
    !environment ||
    typeof release !== "string" ||
    !releasePattern.test(release) ||
    (environment !== "development" && release.endsWith("-dirty"))
  ) {
    return disabledConfig();
  }

  if (environment === "development" && !input.localEnabled) return disabledConfig();

  return {
    enabled: true,
    context: { environment, release, runtime: input.runtime },
  };
}

export function resolveRuntimeTelemetryConfig(
  runtime: TelemetryContext["runtime"],
): ResolvedTelemetryConfig {
  return resolveTelemetryConfig({
    target: process.env.NEXT_PUBLIC_KDM_SENTRY_TARGET,
    release: process.env.NEXT_PUBLIC_KDM_RELEASE,
    disabled:
      process.env.NEXT_PUBLIC_KDM_DISABLE_SENTRY === "1" ||
      process.env.KDM_DISABLE_SENTRY === "1",
    localEnabled: process.env.NEXT_PUBLIC_KDM_SENTRY_LOCAL_ENABLED === "1",
    test: process.env.NODE_ENV === "test",
    runtime,
  });
}

export function createTelemetrySentryOptions(config: ResolvedTelemetryConfig) {
  const context = config.context;

  return {
    enabled: config.enabled,
    ...(context ? { environment: context.environment, release: context.release } : {}),
    attachStacktrace: false,
    sendDefaultPii: false,
    sendClientReports: false,
    enableLogs: false,
    beforeSendLog: () => null,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,
    beforeSend: (event: unknown) => (context ? filterSafeEvent(event, context) : null),
    defaultIntegrations: false as const,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
  };
}
