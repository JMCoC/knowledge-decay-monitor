// Task 0 skeleton — verifies Deno Edge can import src/modules/analysis/retrieval.ts.
// Replaced by the real entrypoint in Task 5. NOT committed during Task 0.

// @ts-expect-error TS5097 — Deno requires the .ts extension on relative imports; tsc rejects it without allowImportingTsExtensions. Temporary until Task 5.
import { computeRequestFingerprint } from "../../../src/modules/analysis/retrieval.ts";

declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
};

Deno.serve((req: Request): Response => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/health")) {
    return new Response(
      JSON.stringify({
        ok: true,
        import: typeof computeRequestFingerprint,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  return new Response("not found", { status: 404 });
});
