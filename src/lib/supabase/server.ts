import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "../../types/database";
import { getSupabaseEnv } from "./env";

export type SupabaseCookieUpdate = { name: string; value: string; options: CookieOptions };

export type CookieWriteObserver = (
  cookiesToSet: SupabaseCookieUpdate[],
  headers?: Record<string, string>,
) => void;

/** For Server Components only. Proxy owns refresh and response cookie writes. */
export async function createReadOnlyClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = getSupabaseEnv();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {
        // Server Component responses cannot set cookies. The Next.js Proxy
        // refreshes the session before rendering this component.
      },
    },
  });
}

/** For Server Actions and Route Handlers that must persist Auth mutations. */
export async function createWritableClient(onCookieWrite?: CookieWriteObserver) {
  const cookieStore = await cookies();
  const { url, publishableKey } = getSupabaseEnv();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet, headers) => {
        if (onCookieWrite) {
          onCookieWrite(cookiesToSet, headers);
          return;
        }

        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}
