import { redirect } from "next/navigation";
import { createReadOnlyClient } from "../../lib/supabase/server";
import { IdentityError } from "../../modules/identity/errors";
import { requireAuthenticatedUser } from "../../modules/identity/session";
import { PasswordForm } from "../../modules/identity/password-form";

export default async function ResetPasswordPage() {
  try {
    await requireAuthenticatedUser(await createReadOnlyClient());
  } catch (error) {
    if (error instanceof IdentityError && error.code === "UNAUTHENTICATED") {
      redirect("/forgot-password?error=invalid-link");
    }
    throw error;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 sm:px-6">
      <PasswordForm mode="reset" />
    </main>
  );
}
