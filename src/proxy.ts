import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptionsWithName } from "@supabase/ssr";
import type { Database } from "./types/database";
import { getSupabaseEnv } from "./lib/supabase/env";

type CookieUpdate = { name: string; value: string; options: CookieOptionsWithName };

const protectedPaths = ["/app", "/onboarding"];

function isProtectedPath(pathname: string) {
  return protectedPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function proxy(request: NextRequest) {
  const { url, publishableKey } = getSupabaseEnv();
  let response = NextResponse.next({ request });
  const cookieUpdates = new Map<string, CookieUpdate>();
  const cacheHeaders = new Map<string, string>();

  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const cookie of cookiesToSet) {
          request.cookies.set(cookie.name, cookie.value);
          cookieUpdates.set(cookie.name, cookie);
        }
        for (const [name, value] of Object.entries(headers)) {
          cacheHeaders.set(name, value);
        }

        response = NextResponse.next({ request });
        for (const { name, value, options } of cookieUpdates.values()) {
          response.cookies.set(name, value, options);
        }
        for (const [name, value] of cacheHeaders) {
          response.headers.set(name, value);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  response.headers.set("Cache-Control", "private, no-store");

  // Auth being unreachable is not evidence that the user is anonymous.
  if (!error && !data?.claims && isProtectedPath(request.nextUrl.pathname)) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));
    for (const { name, value, options } of cookieUpdates.values()) {
      redirect.cookies.set(name, value, options);
    }
    for (const [name, value] of cacheHeaders) {
      redirect.headers.set(name, value);
    }
    redirect.headers.set("Cache-Control", "private, no-store");
    return redirect;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
