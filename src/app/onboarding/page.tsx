import { redirect } from "next/navigation";
import { OnboardingForm } from "../../modules/workspace/onboarding-form";
import { getIdentityContext } from "../../modules/identity/session";
import { createReadOnlyClient } from "../../lib/supabase/server";

export default async function OnboardingPage() {
  const context = await getIdentityContext(await createReadOnlyClient());
  if (context.state === "anonymous") redirect("/login");
  if (context.state === "ready") redirect("/app");

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 sm:px-6">
      <OnboardingForm />
    </main>
  );
}
