import { redirect } from "next/navigation";
import { AuthForm } from "../../../modules/identity/auth-form";
import { analysisContinuationPath, parseAnalysisContinuation } from "../../../modules/identity/analysis-continuation";
import { getIdentityContext } from "../../../modules/identity/session";
import { createReadOnlyClient } from "../../../lib/supabase/server";

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const analysisId = parseAnalysisContinuation(query.analysisId);
  const context = await getIdentityContext(await createReadOnlyClient());
  if (context.state === "onboarding") redirect("/onboarding");
  if (context.state === "ready") redirect(analysisContinuationPath(analysisId) ?? "/app");

  return <AuthForm mode="login" analysisId={analysisId ?? undefined} />;
}
