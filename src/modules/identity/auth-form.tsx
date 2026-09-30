"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { login, register } from "./actions";
import { loginSchema, registerSchema } from "./schemas";

type AuthFormProps = { mode: "login" | "register" };

const fieldClassName =
  "mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-cyan-700 focus:ring-2 focus:ring-cyan-700/20 disabled:bg-slate-100";

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isRegister = mode === "register";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    if (isRegister) {
      const parsed = registerSchema.safeParse({ email, password, confirmPassword });
      if (!parsed.success) {
        setMessage(parsed.error.issues[0]?.message ?? "Please check the information and try again.");
        return;
      }

      setPending(true);
      try {
        const result = await register(parsed.data);
        if (!result.ok) {
          setMessage(result.error.message);
          return;
        }
        router.replace(result.data.destination);
        router.refresh();
      } catch {
        setMessage("We couldn't create your account. Try again.");
      } finally {
        setPending(false);
      }
      return;
    }

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Please check your email and password.");
      return;
    }

    setPending(true);
    try {
      const result = await login(parsed.data);
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      router.replace(result.data.destination);
      router.refresh();
    } catch {
      setMessage("We couldn't sign you in. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="mb-7">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-800">
          Knowledge Decay Monitor
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
          {isRegister ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {isRegister
            ? "Start a private workspace for your organization’s knowledge."
            : "Sign in to continue to your workspace."}
        </p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
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

        <div>
          <label htmlFor="password" className="text-sm font-medium text-slate-800">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={isRegister ? "new-password" : "current-password"}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={fieldClassName}
            disabled={pending}
          />
          {isRegister ? (
            <p className="mt-1.5 text-xs text-slate-500">Use at least 6 characters.</p>
          ) : null}
        </div>

        {isRegister ? (
          <div>
            <label htmlFor="confirmPassword" className="text-sm font-medium text-slate-800">
              Confirm password
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
        ) : null}

        {message ? (
          <p id="auth-message" role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="inline-flex w-full items-center justify-center rounded-lg bg-cyan-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-900 disabled:cursor-wait disabled:opacity-70"
        >
          {pending ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
        </button>
      </form>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        {isRegister ? (
          <p className="text-slate-600">
            Already have an account?{" "}
            <Link href="/login" className="font-semibold text-cyan-900 underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        ) : (
          <>
            <Link href="/forgot-password" className="font-semibold text-cyan-900 underline-offset-4 hover:underline">
              Forgot password?
            </Link>
            <Link href="/register" className="font-semibold text-cyan-900 underline-offset-4 hover:underline">
              Create account
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
