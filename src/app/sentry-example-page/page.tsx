import DiagnosticsPanel from "./diagnostics-panel";
import { authorizeDiagnostics } from "./actions";

export const dynamic = "force-dynamic";

export default async function SentryExamplePage() {
  const authorization = await authorizeDiagnostics();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Observability diagnostics</h1>
      {authorization.ok ? (
        <DiagnosticsPanel expiresAt={authorization.data.expiresAt} />
      ) : (
        <p role="status">Diagnostic access is unavailable.</p>
      )}
    </main>
  );
}
