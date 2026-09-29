import { redirect } from "next/navigation";
import { AppShell } from "../../components/shell/app-shell";
import { getIdentityContext } from "../../modules/identity/session";
import { getOwnWorkspace } from "../../modules/workspace/queries";
import { createReadOnlyClient } from "../../lib/supabase/server";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const context = await getIdentityContext(await createReadOnlyClient());
  if (context.state === "anonymous") redirect("/login");
  if (context.state === "onboarding") redirect("/onboarding");

  const workspace = await getOwnWorkspace();
  return (
    <AppShell
      workspaceName={workspace.name}
      fullName={context.fullName}
      role={context.actor.role}
    >
      {children}
    </AppShell>
  );
}
