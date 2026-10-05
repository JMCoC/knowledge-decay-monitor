"use client";

import { useState } from "react";
import type { CaptureReceipt } from "../lib/observability/safe-event";
import { captureUnexpectedError } from "../lib/observability/unexpected-error";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const [captured, setCaptured] = useState(() => ({
    error,
    receipt: captureUnexpectedError(error, "render"),
  }));

  if (captured.error !== error) {
    setCaptured({ error, receipt: captureUnexpectedError(error, "render") });
  }
  const receipt: CaptureReceipt | undefined = captured.error === error ? captured.receipt : undefined;

  return (
    <html lang="en">
      <body>
        <main role="alert">
          <h1>Something went wrong</h1>
          <p>Please try again. If the problem continues, contact support.</p>
          {receipt?.correlationId ? (
            <p>
              Support reference: <code>{receipt.correlationId}</code>
            </p>
          ) : null}
          <button onClick={retry} type="button">
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
