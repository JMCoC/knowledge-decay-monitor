import "server-only";

import type { ActionResult, AnalysisPage, CreditLedgerItem, CreditSnapshot } from "../../types/contracts";
import { captureOperationFailure } from "../../lib/observability/operation-events";
import { createReadOnlyClient } from "../../lib/supabase/server";
import { IdentityError, getIdentityContext } from "../identity";
import {
  creditLedgerPageSchema,
  creditLedgerQuerySchema,
  creditSnapshotSchema,
} from "./schemas";

type CreditReadOperation = "snapshot" | "ledger";

function creditReadFailure(
  operation: CreditReadOperation,
  sqlState?: string,
  httpStatus?: number,
): ActionResult<never> {
  if (httpStatus === 401) {
    return { ok: false, error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." } };
  }
  if (sqlState === "42501") {
    return { ok: false, error: { code: "FORBIDDEN", message: "You don't have permission to view these credits." } };
  }
  if (sqlState === "22023") {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Please check the credit query and try again." } };
  }

  let correlationId: string | undefined;
  try {
    correlationId = crypto.randomUUID();
    captureOperationFailure({
      module: "credits",
      operation,
      code: "INTERNAL_ERROR",
      correlationId,
    });
  } catch {
    // Telemetry failures must not change the controlled product result.
  }

  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: operation === "snapshot"
        ? "We couldn't load the credit balance."
        : "We couldn't load the credit ledger.",
      ...(correlationId ? { correlationId } : {}),
    },
  };
}

function identityFailure(error: unknown, operation: CreditReadOperation): ActionResult<never> {
  if (error instanceof IdentityError) {
    if (error.code === "UNAUTHENTICATED") {
      return { ok: false, error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." } };
    }
    if (error.code === "FORBIDDEN" || error.code === "WORKSPACE_REQUIRED") {
      return { ok: false, error: { code: "FORBIDDEN", message: "A workspace is required to view credits." } };
    }
  }
  return creditReadFailure(operation);
}

/** Returns a ledger-derived aggregate for any verified workspace member. */
export async function getCreditSnapshot(): Promise<ActionResult<CreditSnapshot>> {
  try {
    const client = await createReadOnlyClient();
    const context = await getIdentityContext(client);
    if (context.state === "anonymous") {
      return { ok: false, error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." } };
    }
    if (context.state === "onboarding") {
      return { ok: false, error: { code: "FORBIDDEN", message: "A workspace is required to view credits." } };
    }

    const { data, error, status } = await client.rpc("get_credit_snapshot");
    if (error) return creditReadFailure("snapshot", error.code, status);

    const parsed = creditSnapshotSchema.safeParse(data);
    if (!parsed.success) return creditReadFailure("snapshot");
    return { ok: true, data: parsed.data };
  } catch (error) {
    return identityFailure(error, "snapshot");
  }
}

/** Returns a paged, role-authorized ledger projection through the caller's session. */
export async function listCreditLedger(
  query: { page?: number; pageSize?: number } = {},
): Promise<ActionResult<AnalysisPage<CreditLedgerItem>>> {
  const parsedQuery = creditLedgerQuerySchema.safeParse(query);
  if (!parsedQuery.success) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Please check the credit query and try again." } };
  }

  try {
    const client = await createReadOnlyClient();
    const context = await getIdentityContext(client);
    if (context.state === "anonymous") {
      return { ok: false, error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." } };
    }
    if (context.state === "onboarding") {
      return { ok: false, error: { code: "FORBIDDEN", message: "A workspace is required to view credits." } };
    }
    if (context.actor.role !== "Admin" && context.actor.role !== "QA Lead") {
      return { ok: false, error: { code: "FORBIDDEN", message: "You don't have permission to view the credit ledger." } };
    }

    const { page, pageSize } = parsedQuery.data;
    const { data, error, status } = await client.rpc("list_credit_ledger", {
      p_page: page,
      p_page_size: pageSize,
    });
    if (error) return creditReadFailure("ledger", error.code, status);

    const parsed = creditLedgerPageSchema.safeParse(data);
    if (!parsed.success || parsed.data.page !== page || parsed.data.pageSize !== pageSize
        || parsed.data.items.length > pageSize) {
      return creditReadFailure("ledger");
    }
    return { ok: true, data: parsed.data };
  } catch (error) {
    return identityFailure(error, "ledger");
  }
}
