import type { ActionError } from "../types/contracts";

export function OperationError({ error }: { error: ActionError }) {
  return (
    <div role="alert">
      <p>{error.message}</p>
      {error.correlationId ? (
        <p>
          Reference: <code>{error.correlationId}</code>
        </p>
      ) : null}
    </div>
  );
}
