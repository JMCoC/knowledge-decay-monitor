"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createWorkspace, reconcileWorkspaceBootstrap } from "./actions";
import { createWorkspaceSchema } from "./schemas";

const fieldClassName =
  "mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-950 shadow-sm outline-none transition focus:border-cyan-700 focus:ring-2 focus:ring-cyan-700/20 disabled:bg-slate-100";

export function OnboardingForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [fullName, setFullName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [retryAllowed, setRetryAllowed] = useState(true);

  function navigateToApp() {
    router.replace("/app");
    router.refresh();
  }

  async function checkPersistedState() {
    const result = await reconcileWorkspaceBootstrap();
    if (!result.ok) {
      if (result.error.code === "UNAUTHENTICATED") {
        router.replace("/login");
        router.refresh();
      } else {
        setRetryAllowed(false);
        setMessage("We couldn't confirm your workspace setup. Check the status before trying again.");
      }
      return;
    }

    if (result.data.state === "ready") {
      navigateToApp();
      return;
    }

    setRetryAllowed(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    const parsed = createWorkspaceSchema.safeParse({ name, fullName });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Please check the information and try again.");
      return;
    }

    setPending(true);
    try {
      const result = await createWorkspace(parsed.data);
      if (result.ok) {
        navigateToApp();
        return;
      }

      if (result.error.code === "UNAUTHENTICATED") {
        router.replace("/login");
        router.refresh();
        return;
      }

      setMessage(result.error.message);
      if (result.error.code === "CONFLICT" || result.error.code === "INTERNAL_ERROR") {
        await checkPersistedState();
      }
    } catch {
      setRetryAllowed(false);
      setMessage("We couldn't confirm your workspace setup. Check the status before trying again.");
    } finally {
      setPending(false);
    }
  }

  async function handleCheckStatus() {
    setPending(true);
    try {
      await checkPersistedState();
    } catch {
      setRetryAllowed(false);
      setMessage("We couldn't confirm your workspace setup. Check the status before trying again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="mb-7">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-800">
          Workspace setup
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
          Create your organization’s workspace
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Your account will be the first Admin for this private workspace.
        </p>
      </div>

      <form className="space-y-5" onSubmit={handleSubmit} noValidate>
        <div>
          <label htmlFor="fullName" className="text-sm font-medium text-slate-800">
            Your name
          </label>
          <input
            id="fullName"
            name="fullName"
            type="text"
            autoComplete="name"
            required
            maxLength={240}
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            className={fieldClassName}
            disabled={pending}
          />
        </div>

        <div>
          <label htmlFor="workspaceName" className="text-sm font-medium text-slate-800">
            Workspace name
          </label>
          <input
            id="workspaceName"
            name="name"
            type="text"
            autoComplete="organization"
            required
            maxLength={240}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={fieldClassName}
            disabled={pending}
          />
        </div>

        {message ? (
          <p id="workspace-message" role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending || !retryAllowed}
          className="inline-flex w-full items-center justify-center rounded-lg bg-cyan-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-cyan-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-900 disabled:cursor-wait disabled:opacity-70"
        >
          {pending ? "Please wait…" : "Create workspace"}
        </button>
      </form>

      {!retryAllowed ? (
        <button
          type="button"
          disabled={pending}
          onClick={handleCheckStatus}
          className="mt-4 text-sm font-semibold text-cyan-900 underline-offset-4 hover:underline disabled:opacity-60"
        >
          Check workspace status
        </button>
      ) : null}
    </section>
  );
}
