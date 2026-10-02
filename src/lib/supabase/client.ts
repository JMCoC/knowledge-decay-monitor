"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "../../types/database";
import { getSupabaseEnv } from "./env";

export function createBrowserSupabaseClient() {
  const { url, publishableKey } = getSupabaseEnv();
  return createBrowserClient<Database>(url, publishableKey);
}
