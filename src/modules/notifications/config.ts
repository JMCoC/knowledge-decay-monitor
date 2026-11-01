import { NotificationReadinessError, type NotificationConfig } from "./types";

export const NOTIFICATIONS_FROM =
  "Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopback(url: URL) {
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

function parseServiceOrigin(value: string) {
  if (/\s|\\/.test(value) || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) {
    throw new NotificationReadinessError();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotificationReadinessError();
  }

  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url)))
    || value.includes("@")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new NotificationReadinessError();
  }
  return url;
}

/** Accept HTTPS origins, plus explicit local loopback origins for development. */
export function validateAppOrigin(value: string) {
  return parseServiceOrigin(value).origin;
}

export function validateNotificationsFrom(value: string) {
  if (value !== NOTIFICATIONS_FROM) throw new NotificationReadinessError();
  return value;
}

function requiredValue(read: (name: string) => string | undefined, name: string) {
  const value = read(name);
  if (!value || value.trim() !== value || /\s/.test(value)) {
    throw new NotificationReadinessError();
  }
  return value;
}

function validateSentryDsn(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotificationReadinessError();
  }

  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url)))
    || url.username === ""
    || url.password !== ""
    || url.pathname === "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new NotificationReadinessError();
  }
  return value;
}

function environmentValue(value: string | undefined): NotificationConfig["environment"] {
  if (value === undefined || value === "development") return "development";
  if (value === "preview") return "vercel-preview";
  if (value === "production") return "vercel-production";
  throw new NotificationReadinessError();
}

function releaseValue(value: string | undefined) {
  if (value === undefined || value === "") return "local";
  if (value !== "local" && !/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new NotificationReadinessError();
  }
  return value;
}

/** Reads configuration from an injected environment reader, never process.env. */
export function readNotificationsConfig(
  read: (name: string) => string | undefined,
): NotificationConfig {
  const enabledValue = read("NOTIFICATIONS_ENABLED") ?? "false";
  if (enabledValue !== "true" && enabledValue !== "false") {
    throw new NotificationReadinessError();
  }

  if (enabledValue === "false") {
    return {
      enabled: false,
      internalToken: "",
      apiKey: "",
      from: "",
      appOrigin: "",
      supabaseUrl: "",
      serviceRoleKey: "",
      sentryDsn: "",
      environment: "development",
      release: "local",
    };
  }

  const internalToken = requiredValue(read, "NOTIFICATIONS_INTERNAL_TOKEN");
  if (internalToken.length < 32) throw new NotificationReadinessError();

  const apiKey = requiredValue(read, "RESEND_API_KEY");
  const from = validateNotificationsFrom(read("NOTIFICATIONS_FROM") ?? "");
  const appOrigin = validateAppOrigin(requiredValue(read, "APP_ORIGIN"));
  const supabaseUrl = parseServiceOrigin(requiredValue(read, "SUPABASE_URL")).origin;
  const serviceRoleKey = requiredValue(read, "SUPABASE_SERVICE_ROLE_KEY");
  const sentryDsn = validateSentryDsn(requiredValue(read, "SENTRY_DSN"));
  const environment = environmentValue(read("VERCEL_ENV"));
  const release = releaseValue(read("VERCEL_GIT_COMMIT_SHA"));

  return {
    enabled: true,
    internalToken,
    apiKey,
    from,
    appOrigin,
    supabaseUrl,
    serviceRoleKey,
    sentryDsn,
    environment,
    release,
  };
}
