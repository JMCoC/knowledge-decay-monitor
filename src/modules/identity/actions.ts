"use server";

import { AuthApiError } from "@supabase/supabase-js";
import type { ActionResult } from "../../types/contracts";
import { APP_ORIGIN } from "../../lib/app-origin";
import { reportAuthFailure } from "../../lib/observability/auth-events";
import { createWritableClient } from "../../lib/supabase/server";
import { IdentityError } from "./errors";
import { getIdentityContext, requireAuthenticatedUser } from "./session";
import {
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  type LoginInput,
  type RegisterInput,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from "./schemas";

export type AuthDestination = "/onboarding" | "/app";
type AuthActionResult = ActionResult<{ destination: AuthDestination }>;

function failure(
  code: "UNAUTHENTICATED" | "INVALID_INPUT" | "INTERNAL_ERROR",
  message: string,
): AuthActionResult {
  return { ok: false, error: { code, message } };
}

function identityFailure(error: unknown, message: string): AuthActionResult {
  if (error instanceof IdentityError && error.code === "UNAUTHENTICATED") {
    return failure("UNAUTHENTICATED", "Please sign in to continue.");
  }
  return failure("INTERNAL_ERROR", message);
}

async function getDestination(client: Awaited<ReturnType<typeof createWritableClient>>): Promise<AuthActionResult> {
  await requireAuthenticatedUser(client);
  const context = await getIdentityContext(client);

  if (context.state === "anonymous") {
    return failure("UNAUTHENTICATED", "Please sign in to continue.");
  }

  return {
    ok: true,
    data: { destination: context.state === "onboarding" ? "/onboarding" : "/app" },
  };
}

export async function register(input: RegisterInput): Promise<AuthActionResult> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return failure("INVALID_INPUT", "Please check your details and try again.");
  }

  try {
    const client = await createWritableClient();
    const { data, error } = await client.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    if (error) {
      reportAuthFailure({ operation: "register", code: "PROVIDER_ERROR", correlationId: crypto.randomUUID() });
      return failure("INTERNAL_ERROR", "We couldn't create your account. Try again.");
    }

    // Local S1 Auth disables email confirmation; without a session, onboarding
    // must not be presented as if the user were authenticated.
    if (!data.session) {
      reportAuthFailure({ operation: "register", code: "SESSION_UNAVAILABLE", correlationId: crypto.randomUUID() });
      return failure("INTERNAL_ERROR", "We couldn't start your session. Try again.");
    }

    return await getDestination(client);
  } catch (error) {
    reportAuthFailure({ operation: "register", code: "INTERNAL_ERROR", correlationId: crypto.randomUUID() });
    return identityFailure(error, "We couldn't create your account. Try again.");
  }
}

export async function login(input: LoginInput): Promise<AuthActionResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT", "Please check your email and password.");

  try {
    const client = await createWritableClient();
    const { error } = await client.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error instanceof AuthApiError && error.code === "invalid_credentials") {
      return failure("UNAUTHENTICATED", "Invalid email or password.");
    }
    if (error) {
      reportAuthFailure({ operation: "login", code: "PROVIDER_ERROR", correlationId: crypto.randomUUID() });
      return failure("INTERNAL_ERROR", "We couldn't sign you in. Try again.");
    }

    try {
      const result = await getDestination(client);
      if (!result.ok && result.error.code === "INTERNAL_ERROR") {
        reportAuthFailure({ operation: "login", code: "PROFILE_LOOKUP_FAILED", correlationId: crypto.randomUUID() });
      }
      return result;
    } catch {
      reportAuthFailure({ operation: "login", code: "PROFILE_LOOKUP_FAILED", correlationId: crypto.randomUUID() });
      return failure("INTERNAL_ERROR", "We couldn't sign you in. Try again.");
    }
  } catch (error) {
    reportAuthFailure({ operation: "login", code: "INTERNAL_ERROR", correlationId: crypto.randomUUID() });
    return identityFailure(error, "We couldn't sign you in. Try again.");
  }
}

export async function logout(): Promise<ActionResult<{ destination: "/login" }>> {
  try {
    const client = await createWritableClient();
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) {
      reportAuthFailure({ operation: "logout", code: "PROVIDER_ERROR", correlationId: crypto.randomUUID() });
      return {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "We couldn't sign you out. Try again." },
      };
    }
    return { ok: true, data: { destination: "/login" } };
  } catch {
    reportAuthFailure({ operation: "logout", code: "INTERNAL_ERROR", correlationId: crypto.randomUUID() });
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't sign you out. Try again." },
    };
  }
}

export async function requestPasswordReset(
  input: ForgotPasswordInput,
): Promise<ActionResult<{ accepted: true }>> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Enter a valid email address." } };
  }

  try {
    const client = await createWritableClient();
    const { error } = await client.auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo: `${APP_ORIGIN}/auth/callback`,
    });
    if (error) {
      reportAuthFailure({ operation: "recovery", code: "PROVIDER_ERROR", correlationId: crypto.randomUUID() });
      return {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "We couldn't send reset instructions. Try again." },
      };
    }
    return { ok: true, data: { accepted: true } };
  } catch {
    reportAuthFailure({ operation: "recovery", code: "INTERNAL_ERROR", correlationId: crypto.randomUUID() });
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't send reset instructions. Try again." },
    };
  }
}

export async function updatePassword(
  input: ResetPasswordInput,
): Promise<ActionResult<{ updated: true }>> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Please check your new password." } };
  }

  try {
    const client = await createWritableClient();
    await requireAuthenticatedUser(client);
    const { error } = await client.auth.updateUser({ password: parsed.data.password });
    if (error) {
      reportAuthFailure({ operation: "password-update", code: "PROVIDER_ERROR", correlationId: crypto.randomUUID() });
      return {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "We couldn't update your password. Try again." },
      };
    }
    return { ok: true, data: { updated: true } };
  } catch (error) {
    if (error instanceof IdentityError && error.code === "UNAUTHENTICATED") {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Your session expired. Request a new reset link." },
      };
    }
    reportAuthFailure({ operation: "password-update", code: "INTERNAL_ERROR", correlationId: crypto.randomUUID() });
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't update your password. Try again." },
    };
  }
}
