import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { handleNotificationRequest } from "./handler.ts";
import { initNotificationsSentry } from "./sentry.ts";
import { runNotificationDispatch } from "../../../src/modules/notifications/dispatch.ts";
import { createResendSender } from "../../../src/modules/notifications/resend.ts";
import { createNotificationStore } from "../../../src/modules/notifications/store.ts";
import { NotificationReadinessError } from "../../../src/modules/notifications/types.ts";
import type { Database } from "../../../src/types/database.ts";
import type {
  NotificationConfig,
  NotificationHandlerDeps,
  NotificationHandlerEnv,
} from "../../../src/modules/notifications/types.ts";

const DATABASE_TIMEOUT_MS = 3000;

declare const Deno: {
  serve: (handler: (request: Request) => Promise<Response> | Response) => void;
  env: { get(name: string): string | undefined };
};

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

function edgeEnvironment(): NotificationHandlerEnv {
  const names = [
    "NOTIFICATIONS_ENABLED",
    "NOTIFICATIONS_INTERNAL_TOKEN",
    "RESEND_API_KEY",
    "NOTIFICATIONS_FROM",
    "APP_ORIGIN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SENTRY_DSN",
    "NOTIFICATIONS_ENVIRONMENT",
    "NOTIFICATIONS_RELEASE_SHA",
  ];
  return Object.fromEntries(names.map((name) => [name, Deno.env.get(name)]));
}

function createEdgeDependencies(): NotificationHandlerDeps {
  let db: SupabaseClient<Database> | undefined;
  const getDb = (config: NotificationConfig): SupabaseClient<Database> => {
    db ??= createClient<Database>(config.supabaseUrl, config.serviceRoleKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    return db;
  };

  return {
    createStore(config) {
      return createNotificationStore(getDb(config));
    },
    createSender(config) {
      return createResendSender({ apiKey: config.apiKey });
    },
    createReporter(config) {
      return initNotificationsSentry(config);
    },
    async isDispatchEnabled(config) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DATABASE_TIMEOUT_MS);
      try {
        const result = await getDb(config)
          .rpc("notifications_dispatch_enabled")
          .abortSignal(controller.signal);
        if (result.error || typeof result.data !== "boolean") {
          throw new NotificationReadinessError();
        }
        return result.data;
      } catch {
        throw new NotificationReadinessError();
      } finally {
        clearTimeout(timer);
      }
    },
    runDispatch: runNotificationDispatch,
    waitUntil(work) {
      EdgeRuntime.waitUntil(work);
    },
  };
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((request) => handleNotificationRequest(
    request,
    edgeEnvironment(),
    createEdgeDependencies(),
  ));
}
