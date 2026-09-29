import { createServerClient } from "@supabase/ssr";
import type { BrowserContext } from "@playwright/test";

export async function loginAs(
  context: BrowserContext,
  email: string = "admin.a@example.test",
  password: string = "LocalOnly-KDM-2026!"
) {
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
    process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
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
              domain: "localhost",
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
    throw new Error(`Failed to log in as ${email}: ${error?.message}`);
  }

  await context.addCookies(cookiesToSet);
}
