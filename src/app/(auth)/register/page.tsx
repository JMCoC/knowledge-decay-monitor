import { redirect } from "next/navigation";
import { AuthForm } from "../../../modules/identity/auth-form";
import { getIdentityContext } from "../../../modules/identity/session";
import { createReadOnlyClient } from "../../../lib/supabase/server";

export default async function RegisterPage() {
  const context = await getIdentityContext(await createReadOnlyClient());
  if (context.state === "onboarding") redirect("/onboarding");
  if (context.state === "ready") redirect("/app");

  return <AuthForm mode="register" />;
}
