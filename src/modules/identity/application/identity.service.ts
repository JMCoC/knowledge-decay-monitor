import { createReadOnlyClient } from "@/lib/supabase/server";
import type { Actor, IdentityApi } from "@/types/contracts";

export function createIdentityService(): IdentityApi {
    return {
        async requireActor(): Promise<Actor> {
            const supabase = await createReadOnlyClient();

            const {
                data: { user },
                error: authError,
            } = await supabase.auth.getUser();

            if (authError || !user) {
                throw new Error("UNAUTHENTICATED");
            }

            const { data: profile, error: profileError } = await supabase
                .from("profiles")
                .select("id, workspace_id, role")
                .eq("id", user.id)
                .single();

            if (profileError || !profile) {
                throw new Error("PROFILE_NOT_FOUND");
            }

            return {
                userId: user.id,
                workspaceId: profile.workspace_id,
                role: profile.role,
            };
        },
    };
}