import { redirect } from "next/navigation";
import { createReadOnlyClient } from "../lib/supabase/server";
import { getIdentityContext } from "../modules/identity/session";

export default async function HomePage() {
  const context = await getIdentityContext(await createReadOnlyClient());
  if (context.state === "anonymous") redirect("/login");
  if (context.state === "onboarding") redirect("/onboarding");
  redirect("/app");
}
