import "server-only";

import type { Workspace } from "../../types/contracts";
import { createReadOnlyClient } from "../../lib/supabase/server";
import { IdentityError, getIdentityContext } from "../identity";

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
