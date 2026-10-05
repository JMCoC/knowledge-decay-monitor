"use server";

import { AuthApiError } from "@supabase/supabase-js";
import type { ActionResult } from "../../types/contracts";
import { getAppOrigin } from "../../lib/app-origin";
import { reportAuthFailure, type AuthOperation } from "../../lib/observability/auth-events";
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
type AuthActionFailure = Extract<AuthActionResult, { ok: false }>;

function failure(
  code: "UNAUTHENTICATED" | "INVALID_INPUT" | "INTERNAL_ERROR",
  message: string,
  correlationId?: string,
): AuthActionFailure {
  return { ok: false, error: { code, message, ...(correlationId ? { correlationId } : {}) } };
}

function reportFailure(operation: AuthOperation, code: string): string {
  const correlationId = crypto.randomUUID();
  try {
    reportAuthFailure({ operation, code, correlationId });
  } catch {
    // Telemetry must not change the controlled product result.
  }
  return correlationId;
}

function reportedFailure(
  operation: AuthOperation,
  code: string,
  message: string,
): AuthActionFailure {
  return failure("INTERNAL_ERROR", message, reportFailure(operation, code));
}

function attachFailureReference(
  result: AuthActionResult,
  operation: AuthOperation,
  code: string,
): AuthActionResult {
  if (result.ok || result.error.code !== "INTERNAL_ERROR") return result;
  const correlationId = reportFailure(operation, code);
  return { ...result, error: { ...result.error, correlationId } };
}

function identityFailure(error: unknown, message: string): AuthActionFailure {
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
      return reportedFailure("register", "PROVIDER_ERROR", "We couldn't create your account. Try again.");
    }

    // Local S1 Auth disables email confirmation; without a session, onboarding
    // must not be presented as if the user were authenticated.
    if (!data.session) {
      return reportedFailure("register", "SESSION_UNAVAILABLE", "We couldn't start your session. Try again.");
    }

    return attachFailureReference(
      await getDestination(client),
      "register",
      "PROFILE_LOOKUP_FAILED",
    );
  } catch (error) {
    const mapped = identityFailure(error, "We couldn't create your account. Try again.");
    if (mapped.error.code === "UNAUTHENTICATED") return mapped;
    return reportedFailure("register", "INTERNAL_ERROR", "We couldn't create your account. Try again.");
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
      return reportedFailure("login", "PROVIDER_ERROR", "We couldn't sign you in. Try again.");
    }

    try {
      return attachFailureReference(
        await getDestination(client),
        "login",
        "PROFILE_LOOKUP_FAILED",
      );
    } catch (error) {
      const mapped = identityFailure(error, "We couldn't sign you in. Try again.");
      if (mapped.error.code === "UNAUTHENTICATED") return mapped;
      return reportedFailure("login", "PROFILE_LOOKUP_FAILED", "We couldn't sign you in. Try again.");
    }
  } catch (error) {
    const mapped = identityFailure(error, "We couldn't sign you in. Try again.");
    if (mapped.error.code === "UNAUTHENTICATED") return mapped;
    return reportedFailure("login", "INTERNAL_ERROR", "We couldn't sign you in. Try again.");
  }
}

export async function logout(): Promise<ActionResult<{ destination: "/login" }>> {
  try {
    const client = await createWritableClient();
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) {
      return reportedFailure("logout", "PROVIDER_ERROR", "We couldn't sign you out. Try again.");
    }
    return { ok: true, data: { destination: "/login" } };
  } catch {
    return reportedFailure("logout", "INTERNAL_ERROR", "We couldn't sign you out. Try again.");
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
      redirectTo: `${getAppOrigin()}/auth/callback`,
    });
    if (error) {
      return reportedFailure("recovery", "PROVIDER_ERROR", "We couldn't send reset instructions. Try again.");
    }
    return { ok: true, data: { accepted: true } };
  } catch {
    return reportedFailure("recovery", "INTERNAL_ERROR", "We couldn't send reset instructions. Try again.");
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
      return reportedFailure("password-update", "PROVIDER_ERROR", "We couldn't update your password. Try again.");
    }
    return { ok: true, data: { updated: true } };
  } catch (error) {
    if (error instanceof IdentityError && error.code === "UNAUTHENTICATED") {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Your session expired. Request a new reset link." },
      };
    }
    return reportedFailure("password-update", "INTERNAL_ERROR", "We couldn't update your password. Try again.");
  }
}
