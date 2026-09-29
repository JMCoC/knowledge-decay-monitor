import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { APP_ORIGIN } from "../../../lib/app-origin";
import { reportAuthFailure } from "../../../lib/observability/auth-events";
import { createWritableClient } from "../../../lib/supabase/server";

type CookieUpdate = { name: string; value: string; options: CookieOptions };

function redirect(path: string, cookies: CookieUpdate[] = [], headers: Map<string, string> = new Map()) {
  const response = NextResponse.redirect(new URL(path, APP_ORIGIN));
  for (const [name, value] of headers) response.headers.set(name, value);
  for (const { name, value, options } of cookies) response.cookies.set(name, value, options);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");
  if (!tokenHash || type !== "recovery") {
    return redirect("/forgot-password?error=invalid-link");
  }

  const cookieUpdates = new Map<string, CookieUpdate>();
  const responseHeaders = new Map<string, string>();

  try {
    const client = await createWritableClient((cookiesToSet, headers = {}) => {
      for (const cookie of cookiesToSet) cookieUpdates.set(cookie.name, cookie);
      for (const [name, value] of Object.entries(headers)) responseHeaders.set(name, value);
    });
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });

    if (error) {
      reportAuthFailure({ operation: "recovery", code: "PROVIDER_ERROR", correlationId: crypto.randomUUID() });
      return redirect("/forgot-password?error=invalid-link");
    }
    return redirect("/reset-password", [...cookieUpdates.values()], responseHeaders);
  } catch {
    reportAuthFailure({ operation: "recovery", code: "INTERNAL_ERROR", correlationId: crypto.randomUUID() });
    return redirect("/forgot-password?error=invalid-link");
  }
}
