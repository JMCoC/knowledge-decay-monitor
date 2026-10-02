"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { requestPasswordReset, updatePassword } from "./actions";
import { forgotPasswordSchema, resetPasswordSchema } from "./schemas";

type PasswordFormProps = {
  mode: "forgot" | "reset";
  invalidLink?: boolean;
};

const fieldClassName =
  "mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-950 shadow-sm outline-none transition focus:border-cyan-700 focus:ring-2 focus:ring-cyan-700/20 disabled:bg-slate-100";

export function PasswordForm({ mode, invalidLink = false }: PasswordFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(
    invalidLink ? "This reset link is invalid or has expired. Request a new one." : null,
  );
  const [accepted, setAccepted] = useState(false);
  const [updated, setUpdated] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    if (mode === "forgot") {
      const parsed = forgotPasswordSchema.safeParse({ email });
      if (!parsed.success) {
        setMessage(parsed.error.issues[0]?.message ?? "Enter a valid email address.");
        return;
      }

      setPending(true);
      try {
        const result = await requestPasswordReset(parsed.data);
        if (!result.ok) {
          setMessage(result.error.message);
          return;
        }
        setAccepted(true);
      } catch {
        setMessage("We couldn't send reset instructions. Try again.");
      } finally {
        setPending(false);
      }
      return;
    }

    const parsed = resetPasswordSchema.safeParse({ password, confirmPassword });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Please check your new password.");
      return;
    }

    setPending(true);
    try {
      const result = await updatePassword(parsed.data);
      if (!result.ok) {
        if (result.error.code === "UNAUTHENTICATED") {
          router.replace("/forgot-password?error=invalid-link");
          router.refresh();
          return;
        }
        setMessage(result.error.message);
        return;
      }
      setUpdated(true);
    } catch {
      setMessage("We couldn't update your password. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (mode === "forgot" && accepted) {
    return (
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Check your email</h1>
        <p role="status" className="mt-3 text-sm leading-6 text-slate-700">
          If an account exists for this email, you will receive password reset instructions.
        </p>
        <Link href="/login" className="mt-6 inline-flex font-semibold text-cyan-900 underline-offset-4 hover:underline">
          Return to sign in
        </Link>
      </section>
    );
  }

  if (mode === "reset" && updated) {
    return (
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Password updated</h1>
        <p role="status" className="mt-3 text-sm leading-6 text-slate-700">
          Your password has been updated. Continue to your account.
        </p>
        <Link href="/" className="mt-6 inline-flex font-semibold text-cyan-900 underline-offset-4 hover:underline">
          Continue
        </Link>
      </section>
    );
  }

  return (
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="mb-7">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-800">
          Knowledge Decay Monitor
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
          {mode === "forgot" ? "Reset your password" : "Choose a new password"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {mode === "forgot"
            ? "Enter your account email and we will send reset instructions."
            : "Use at least 6 characters for your new password."}
        </p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        {mode === "forgot" ? (
          <div>
            <label htmlFor="email" className="text-sm font-medium text-slate-800">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={fieldClassName}
              disabled={pending}
            />
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="password" className="text-sm font-medium text-slate-800">
                New password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={fieldClassName}
                disabled={pending}
              />
            </div>
            <div>
              <label htmlFor="confirmPassword" className="text-sm font-medium text-slate-800">
                Confirm new password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className={fieldClassName}
                disabled={pending}
              />
            </div>
          </>
        )}

        {message ? (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex w-full items-center justify-center rounded-lg bg-cyan-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-900 disabled:cursor-wait disabled:opacity-70"
        >
          {pending ? "Please wait…" : mode === "forgot" ? "Send reset instructions" : "Update password"}
        </button>
      </form>

      <Link href="/login" className="mt-6 inline-flex text-sm font-semibold text-cyan-900 underline-offset-4 hover:underline">
        Return to sign in
      </Link>
    </section>
  );
}
