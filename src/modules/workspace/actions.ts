"use server";

import type { ActionResult, CreateWorkspaceInput } from "../../types/contracts";
import { reportAuthFailure } from "../../lib/observability/auth-events";
import { createReadOnlyClient, createWritableClient } from "../../lib/supabase/server";
import { IdentityError, getIdentityContext, requireAuthenticatedUser } from "../identity";
import { createWorkspaceSchema } from "./schemas";

const invalidInputMessage = "Please check the workspace details and try again.";

function failure<T>(
  code: "UNAUTHENTICATED" | "INVALID_INPUT" | "CONFLICT" | "INTERNAL_ERROR",
  message: string,
  correlationId?: string,
): ActionResult<T> {
  return { ok: false, error: { code, message, ...(correlationId ? { correlationId } : {}) } };
}

function reportBootstrapFailure<T>(code: string, message: string): ActionResult<T> {
  const correlationId = crypto.randomUUID();
  try {
    reportAuthFailure({ operation: "bootstrap", code, correlationId });
  } catch {
    // Telemetry must not change the controlled product result.
  }
  return failure("INTERNAL_ERROR", message, correlationId);
}

async function reconcileUncertainBootstrap(
  client: Awaited<ReturnType<typeof createWritableClient>>,
): Promise<ActionResult<{ workspaceId: string }>> {
  try {
    const context = await getIdentityContext(client);
    if (context.state === "ready") {
      return { ok: true, data: { workspaceId: context.actor.workspaceId } };
    }
    return reportBootstrapFailure(
      "PROVIDER_ERROR",
      "We couldn't create your workspace. Try again.",
    );
  } catch {
    return reportBootstrapFailure(
      "PROFILE_LOOKUP_FAILED",
      "We couldn't create your workspace. Try again.",
    );
  }
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<ActionResult<{ workspaceId: string }>> {
  const parsed = createWorkspaceSchema.safeParse(input);
  if (!parsed.success) return failure("INVALID_INPUT", invalidInputMessage);

  try {
    const client = await createWritableClient();
    await requireAuthenticatedUser(client);

    let response: Awaited<ReturnType<typeof client.rpc>>;
    try {
      response = await client.rpc("bootstrap_workspace", {
        workspace_name: parsed.data.name,
        full_name: parsed.data.fullName,
      });
    } catch {
      return reconcileUncertainBootstrap(client);
    }

    const { data, error } = response;

    if (error) {
      if (error.code === "23505") {
        return failure("CONFLICT", "You already belong to a workspace.");
      }
      if (error.code === "22023") return failure("INVALID_INPUT", invalidInputMessage);

      if (error.code === "42501") {
        try {
          await requireAuthenticatedUser(client);
        } catch (authError) {
          if (authError instanceof IdentityError && authError.code === "UNAUTHENTICATED") {
            return failure("UNAUTHENTICATED", "Please sign in to continue.");
          }
        }
      }

      return reportBootstrapFailure("PROVIDER_ERROR", "We couldn't create your workspace. Try again.");
    }

    const workspaceId = data as string | null;
    if (!workspaceId) return reconcileUncertainBootstrap(client);
    return { ok: true, data: { workspaceId } };
  } catch (error) {
    if (error instanceof IdentityError && error.code === "UNAUTHENTICATED") {
      return failure("UNAUTHENTICATED", "Please sign in to continue.");
    }
    return reportBootstrapFailure("INTERNAL_ERROR", "We couldn't create your workspace. Try again.");
  }
}

/** Re-checks the persisted bootstrap state after an uncertain client response. */
export async function reconcileWorkspaceBootstrap(): Promise<
  ActionResult<{ state: "onboarding" | "ready" }>
> {
  try {
    const context = await getIdentityContext(await createReadOnlyClient());
    if (context.state === "anonymous") {
      return failure("UNAUTHENTICATED", "Please sign in to continue.");
    }
    return {
      ok: true,
      data: { state: context.state === "ready" ? "ready" : "onboarding" },
    };
  } catch (error) {
    if (error instanceof IdentityError && error.code === "UNAUTHENTICATED") {
      return failure("UNAUTHENTICATED", "Please sign in to continue.");
    }
    return reportBootstrapFailure(
      "PROFILE_LOOKUP_FAILED",
      "We couldn't confirm your workspace setup. Refresh and try again.",
    );
  }
}
