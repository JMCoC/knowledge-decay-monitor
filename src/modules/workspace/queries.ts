import "server-only";

import type { ActionResult, EligibleOwner, Workspace } from "../../types/contracts";
import { createReadOnlyClient } from "../../lib/supabase/server";
import { IdentityError, getIdentityContext, requireDocumentActor } from "../identity";

export async function getOwnWorkspace(): Promise<Pick<Workspace, "id" | "name">> {
  try {
    const client = await createReadOnlyClient();
    const context = await getIdentityContext(client);

    if (context.state === "anonymous") throw new IdentityError("UNAUTHENTICATED");
    if (context.state === "onboarding") throw new IdentityError("WORKSPACE_REQUIRED");

    const { data, error } = await client
      .from("workspaces")
      .select("id, name")
      .eq("id", context.actor.workspaceId)
      .maybeSingle();

    if (error || !data) throw new IdentityError("INTERNAL_ERROR");
    return { id: data.id, name: data.name };
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError("INTERNAL_ERROR");
  }
}

/** Lists selectable owner labels from the verified actor's own workspace. */
export async function listEligibleOwners(): Promise<ActionResult<EligibleOwner[]>> {
  try {
    const actor = await requireDocumentActor();
    const client = await createReadOnlyClient();
    const { data, error } = await client
      .from("profiles")
      .select("id, full_name")
      .eq("workspace_id", actor.workspaceId)
      .order("full_name", { ascending: true })
      .order("id", { ascending: true });

    if (error || !data) {
      return {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "We couldn't load the workspace owners." },
      };
    }

    return {
      ok: true,
      data: data.map((profile) => ({ id: profile.id, fullName: profile.full_name })),
    };
  } catch (error) {
    if (error instanceof IdentityError) {
      const code = error.code === "WORKSPACE_REQUIRED" ? "FORBIDDEN" : error.code;
      if (code === "UNAUTHENTICATED" || code === "FORBIDDEN" || code === "INTERNAL_ERROR") {
        return {
          ok: false,
          error: {
            code,
            message:
              code === "UNAUTHENTICATED"
                ? "Please sign in to continue."
                : code === "FORBIDDEN"
                  ? "You don't have permission to list owners."
                  : "We couldn't load the workspace owners.",
          },
        };
      }
    }
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "We couldn't load the workspace owners." },
    };
  }
}
