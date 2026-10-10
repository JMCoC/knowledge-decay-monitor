import { createClient } from "@supabase/supabase-js";
import {
  LOCAL_API_URL,
  LOCAL_APP_ORIGIN,
  readLocalSupabaseRuntime,
  runLocalSupabaseLifecycle,
} from "./local-supabase.mjs";
import { tokenHashFromRecoveryLink, waitForRecoveryLink } from "./mailpit.mjs";

function createAuthClient(runtime) {
  return createClient(runtime.apiUrl, runtime.publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function waitForAuth(runtime) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${runtime.apiUrl}/auth/v1/settings`, {
        headers: { apikey: runtime.publishableKey },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The local gateway and Auth service may still be warming up after start.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Supabase Auth did not become ready after restart.");
}

async function signUp(runtime) {
  const email = `kdm-restart-${crypto.randomUUID()}@example.test`;
  const password = `Kdm-${crypto.randomUUID()}`;
  const { data, error } = await createAuthClient(runtime).auth.signUp({ email, password });
  if (error || !data.user || !data.session) {
    throw new Error("Local Auth signup returned no session; verify email confirmation is disabled.");
  }
  return { email, password, userId: data.user.id };
}

async function requestRecovery(runtime, email) {
  const { error } = await createAuthClient(runtime).auth.resetPasswordForEmail(email, {
    redirectTo: `${LOCAL_APP_ORIGIN}/auth/callback`,
  });
  if (error) throw new Error("Local Auth rejected the recovery request.");
}

async function main() {
  const before = readLocalSupabaseRuntime();
  if (before.apiUrl !== LOCAL_API_URL) throw new Error("Local API URL changed unexpectedly.");
  process.env.KDM_MAILPIT_URL = before.mailpitUrl;
  const account = await signUp(before);
  try {
    await verifyRestart(before, account);
  } finally {
    const admin = createClient(before.apiUrl, before.serviceRoleKey, {
      auth: { autoRefreshToken:false, detectSessionInUrl:false, persistSession:false },
    });
    const { error } = await admin.auth.admin.deleteUser(account.userId);
    if (error) throw new Error("Could not remove the synthetic local restart user.");
  }
}

async function verifyRestart(before, account) {

  await requestRecovery(before, account.email);
  const firstLink = await waitForRecoveryLink(account.email);
  const firstTokenHash = tokenHashFromRecoveryLink(firstLink);

  runLocalSupabaseLifecycle("stop");
  runLocalSupabaseLifecycle("start");

  const after = readLocalSupabaseRuntime();
  if (after.apiUrl !== LOCAL_API_URL) throw new Error("Supabase did not restart on the expected local API URL.");
  process.env.KDM_MAILPIT_URL = after.mailpitUrl;
  await waitForAuth(after);

  const signIn = await createAuthClient(after).auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (signIn.error || signIn.data.user?.id !== account.userId) {
    const safeAuthCodes = new Set([
      "email_not_confirmed",
      "invalid_credentials",
      "signup_disabled",
      "user_banned",
      "validation_failed",
    ]);
    const providerCode = signIn.error?.code;
    const status = typeof signIn.error?.status === "number" ? signIn.error.status : "none";
    const safeErrorNames = new Set(["AuthApiError", "AuthRetryableFetchError", "AuthUnknownError"]);
    const rawErrorName = signIn.error?.name;
    const errorName = typeof rawErrorName === "string" && safeErrorNames.has(rawErrorName)
      ? rawErrorName
      : "other";
    const code = typeof providerCode === "string" && safeAuthCodes.has(providerCode)
      ? providerCode
      : "other";
    const sameUser = signIn.data.user?.id === account.userId;
    const sameKey = before.publishableKey === after.publishableKey;
    throw new Error(
      `Local Auth restart verification failed (status=${status}, code=${code}, error=${errorName}, sameUser=${sameUser}, sameKey=${sameKey}).`,
    );
  }

  await requestRecovery(after, account.email);
  const secondLink = await waitForRecoveryLink(account.email, {
    excludedTokenHashes: [firstTokenHash],
  });
  const secondTokenHash = tokenHashFromRecoveryLink(secondLink);
  if (secondTokenHash === firstTokenHash) throw new Error("Recovery email was not regenerated after restart.");

  console.log("PASS: local recovery email template loaded before and after restart; local Auth data persisted.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Local recovery restart check failed.");
  process.exitCode = 1;
});
