import { PasswordForm } from "../../../modules/identity/password-form";

type ForgotPasswordPageProps = { searchParams: Promise<{ error?: string }> };

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const params = await searchParams;
  return <PasswordForm mode="forgot" invalidLink={params.error === "invalid-link"} />;
}
