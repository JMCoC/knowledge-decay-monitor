import "server-only";

import { isAuthSessionMissingError, type SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "../../types/contracts";
import type { Database } from "../../types/database";
import { createReadOnlyClient } from "../../lib/supabase/server";
import { IdentityError } from "./errors";

export type IdentityContext =
  | { state: "anonymous" }
  | { state: "onboarding"; userId: string }
  | { state: "ready"; actor: Actor; fullName: string };

type IdentityClient = SupabaseClient<Database>;

export async function getIdentityContext(client: IdentityClient): Promise<IdentityContext> {
  const { data, error } = await client.auth.getUser();

  if (error) {
    if (isAuthSessionMissingError(error)) return { state: "anonymous" };
    throw new IdentityError("INTERNAL_ERROR");
  }

  const user = data.user;
  if (!user) return { state: "anonymous" };

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id, workspace_id, role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw new IdentityError("INTERNAL_ERROR");
  if (!profile) return { state: "onboarding", userId: user.id };

  return {
    state: "ready",
    actor: {
      userId: user.id,
      workspaceId: profile.workspace_id,
      role: profile.role,
    },
    fullName: profile.full_name,
  };
}

/** Uses getUser() for a verified Auth identity; callers can pass a writable client. */
export async function requireAuthenticatedUser(
  client?: IdentityClient,
): Promise<{ userId: string }> {
  const authClient = client ?? (await createReadOnlyClient());
  const { data, error } = await authClient.auth.getUser();

  if (error) {
    if (isAuthSessionMissingError(error)) throw new IdentityError("UNAUTHENTICATED");
    throw new IdentityError("INTERNAL_ERROR");
  }
  if (!data.user) throw new IdentityError("UNAUTHENTICATED");

  return { userId: data.user.id };
}

export async function requireActor(): Promise<Actor> {
  const context = await getIdentityContext(await createReadOnlyClient());

  if (context.state === "anonymous") throw new IdentityError("UNAUTHENTICATED");
  if (context.state === "onboarding") throw new IdentityError("WORKSPACE_REQUIRED");

  return context.actor;
}

/** Authorizes the S1 document capability from the verified persisted Profile. */
export function assertDocumentActor(actor: Actor): Actor {
  if (actor.role !== "Admin" && actor.role !== "QA Lead") {
    throw new IdentityError("FORBIDDEN");
  }
  return actor;
}

export async function requireDocumentActor(): Promise<Actor> {
  return assertDocumentActor(await requireActor());
}
