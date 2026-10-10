import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/database";

export function getServiceSupabaseConfig(): { url: URL; urlText: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Privileged Supabase environment is missing.");
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error();
    }
    return { url: parsed, urlText: url, serviceRoleKey };
  } catch {
    throw new Error("Privileged Supabase environment is invalid.");
  }
}

/** Creates a privileged server client without sharing a browser Auth session. */
export function createServiceClient(): SupabaseClient<Database> {
  const { urlText, serviceRoleKey } = getServiceSupabaseConfig();

  return createClient<Database>(urlText, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
