import { createServerClient } from "@supabase/ssr";
import type { BrowserContext } from "@playwright/test";

const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";

export function localSupabaseTestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const url = env.KDM_LOCAL_SUPABASE_URL;
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url !== LOCAL_SUPABASE_URL || !publishableKey) {
    throw new Error("Local Supabase test environment is missing or has the wrong API URL.");
  }
  return { url, publishableKey };
}

export async function loginAs(
  context: BrowserContext,
  email: string = "admin.a@example.test",
  password: string = "LocalOnly-KDM-2026!"
) {
  const { url, publishableKey } = localSupabaseTestConfig();
  const cookiesToSet: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }> = [];

  const supabase = createServerClient(
    url,
    publishableKey,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll(cookies) {
          for (const c of cookies) {
            cookiesToSet.push({
              name: c.name,
              value: c.value,
              domain: "127.0.0.1",
              path: "/",
            });
          }
        },
      },
    }
  );

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.session) {
    throw new Error("Could not sign in with the local Auth fixture.");
  }

  await context.addCookies(cookiesToSet);
}
