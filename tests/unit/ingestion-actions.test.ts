import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadItemInput } from "@/types/contracts";
import { finalizeUpload, reserveUpload } from "@/modules/ingestion/actions";

const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_A = "10000000-0000-4000-8000-000000000001";
const MEMBER_A = "10000000-0000-4000-8000-000000000003";
const DOC_A = "20000000-0000-4000-8000-000000000001";
const VER_A = "30000000-0000-4000-8000-000000000001";

type Role = "Admin" | "QA Lead" | "Member";

type Handlers = {
  /** null models a session requireActor cannot resolve. */
  actor: { userId: string; workspaceId: string; role: Role } | null;
  /** Forces requireActor to throw without going through the actor state. */
  identityFailure?: "UNAUTHENTICATED" | "WORKSPACE_REQUIRED";
  rpc?: (name: string, args: Record<string, unknown>) => unknown;
  version?: unknown;
  storageList?: (path: string) => unknown;
};

const h = vi.hoisted(() => {
  // Mirrors the real IdentityError (single-arg constructor, no FORBIDDEN).
  // Lives here because mock factories are hoisted above top-level code.
  class IdentityError extends Error {
    constructor(
      readonly code: "UNAUTHENTICATED" | "WORKSPACE_REQUIRED" | "INTERNAL_ERROR",
    ) {
      super(
        {
          UNAUTHENTICATED: "Authentication is required.",
          WORKSPACE_REQUIRED: "Workspace setup is required.",
          INTERNAL_ERROR: "Unable to verify the current identity.",
        }[code],
      );
      this.name = "IdentityError";
    }
  }
  return {
    handlers: {} as Handlers,
    rpcCalls: 0,
    IdentityError,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createReadOnlyClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls += 1;
      return h.handlers.rpc
        ? h.handlers.rpc(name, args)
        : { data: null, error: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: h.handlers.version ?? null, error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        list: async (path: string) =>
          h.handlers.storageList
            ? h.handlers.storageList(path)
            : { data: [], error: null },
      }),
    },
  }),
}));

// Faithful to the real requireActor: it resolves the session to an Actor and
// returns whatever role the database says. It throws only when there is no
// usable session. It does NOT reject a Member — if this mock threw for Member,
// every role test would pass on the mock instead of on the guard under test.
// FORBIDDEN is produced by the gate under test, never by identity: if this
// mock threw FORBIDDEN, the role tests would pass on the mock instead of
// on requirePrivilegedActor.
vi.mock("@/modules/identity", () => ({
  IdentityError: h.IdentityError,
  requireActor: async () => {
    if (h.handlers.identityFailure) {
      throw new h.IdentityError(h.handlers.identityFailure);
    }
    if (h.handlers.actor === null) {
      throw new h.IdentityError("UNAUTHENTICATED");
    }
    return h.handlers.actor;
  },
}));

// The seam is a no-op by design; stub it at its S1-03 value so this suite
// tests the actions in isolation from the pipeline entry point.
vi.mock("@/modules/ingestion/processing", () => ({
  startProcessing: async () => "uploaded",
}));

const rpcOk = (args: Record<string, unknown>) => ({
  data: `${WORKSPACE_A}/${args.p_document_id}/${args.p_version_id}/original.pdf`,
  error: null,
});

const rpcFails = (code: string) => ({
  data: null,
  error: { code, message: "boom" },
});

const versionRow = (size: number | null) => ({
  id: VER_A,
  storage_path: `${WORKSPACE_A}/${DOC_A}/${VER_A}/original.md`,
  size_bytes: size,
});

const validPdf: UploadItemInput = {
  metadata: { name: "Runbook", category: "SOP", ownerId: MEMBER_A },
  fileName: "runbook.pdf",
  declaredMimeType: "application/pdf",
  sizeBytes: 2048,
  signature: "JVBERi0xMjM=",
};

const adminActor = () => ({
  userId: ADMIN_A,
  workspaceId: WORKSPACE_A,
  role: "Admin" as Role,
});

beforeEach(() => {
  h.handlers = { actor: adminActor() };
  h.rpcCalls = 0;
});

describe("reserveUpload", () => {
  it("reserves every item and returns one result per index", async () => {
    h.handlers.rpc = (_name, args) => rpcOk(args);
    const result = await reserveUpload([
      validPdf,
      {
        ...validPdf,
        fileName: "b.docx",
        declaredMimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        signature: "UEsDBAADAAA=",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(h.rpcCalls).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].index).toBe(0);
    expect(result.data[1].index).toBe(1);
    const first = result.data[0].outcome;
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.canonicalMimeType).toBe("application/pdf");
      expect(first.storagePath).toMatch(/^aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\//);
      expect(first.storagePath.endsWith("original.pdf")).toBe(true);
    }
  });

  it("sends the extension, never a path, to the RPC", async () => {
    const seen: Record<string, unknown>[] = [];
    h.handlers.rpc = (_name, args) => {
      seen.push(args);
      return rpcOk(args);
    };
    await reserveUpload([validPdf]);
    expect(Object.keys(seen[0]).sort()).toEqual([
      "p_category",
      "p_document_id",
      "p_extension",
      "p_name",
      "p_owner_id",
      "p_size_bytes",
      "p_version_id",
    ]);
    expect(seen[0].p_extension).toBe("pdf");
    expect(seen[0].p_size_bytes).toBe(2048);
  });

  it("rejects a Member at the envelope and reserves nothing", async () => {
    h.handlers.actor = { ...adminActor(), role: "Member" };
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(h.rpcCalls).toBe(0);
  });

  it("accepts a QA Lead", async () => {
    h.handlers.actor = { ...adminActor(), role: "QA Lead" };
    h.handlers.rpc = (_name, args) => rpcOk(args);
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
  });

  it("rejects an out-of-contract batch without calling the database", async () => {
    const result = await reserveUpload([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    expect(h.rpcCalls).toBe(0);
  });

  it("rejects a batch of 11 without calling the database", async () => {
    const result = await reserveUpload(
      Array.from({ length: 11 }, () => validPdf),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    expect(h.rpcCalls).toBe(0);
  });

  // Decision B5.1: the batch is not atomic. Total item failure is still an
  // envelope success — only a global problem (session, role, batch shape)
  // fails the envelope. Contrast with the test above.
  it("returns an ok envelope when every item fails", async () => {
    h.handlers.rpc = (_name, args) => rpcOk(args);
    const result = await reserveUpload([
      { ...validPdf, fileName: "bad.exe" },
      { ...validPdf, signature: "not-base64!!" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.every((item) => !item.outcome.ok)).toBe(true);
    expect(h.rpcCalls).toBe(0);
  });

  // Review Focus #1: one bad item must not take the batch down.
  it("isolates an invalid item and still reserves the rest", async () => {
    h.handlers.rpc = (_name, args) => rpcOk(args);
    const result = await reserveUpload([
      validPdf,
      { ...validPdf, fileName: "bad.exe" },
      { ...validPdf, metadata: { ...validPdf.metadata, name: "Also good" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    expect(result.data[0].outcome.ok).toBe(true);
    expect(result.data[1].outcome.ok).toBe(false);
    if (!result.data[1].outcome.ok) {
      expect(result.data[1].outcome.error.code).toBe("INVALID_INPUT");
    }
    expect(result.data[2].outcome.ok).toBe(true);
  });

  it("never calls the database for an item the schema already rejected", async () => {
    h.handlers.rpc = (_name, args) => rpcOk(args);
    await reserveUpload([
      { ...validPdf, fileName: "bad.exe" },
      { ...validPdf, signature: "not-base64!!" },
    ]);
    expect(h.rpcCalls).toBe(0);
  });

  it("isolates a database failure on one item from the others", async () => {
    h.handlers.rpc = (_name, args) =>
      args.p_name === "Broken" ? rpcFails("22023") : rpcOk(args);
    const result = await reserveUpload([
      validPdf,
      { ...validPdf, metadata: { ...validPdf.metadata, name: "Broken" } },
      { ...validPdf, metadata: { ...validPdf.metadata, name: "Fine" } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].outcome.ok).toBe(true);
    expect(result.data[1].outcome.ok).toBe(false);
    expect(result.data[2].outcome.ok).toBe(true);
  });

  // Review Focus #4: a foreign owner must not leak that the id exists.
  it("reports a cross-tenant owner generically", async () => {
    h.handlers.rpc = () => rpcFails("23503");
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("INVALID_INPUT");
      // Generic on purpose: no tenant, workspace, id, or path may leak.
      // The word "owner" itself is safe — the caller already sent an ownerId.
      expect(outcome.error.message).not.toMatch(/workspace|tenant/i);
      expect(outcome.error.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/);
      expect(outcome.error.message).not.toContain("/");
    }
  });

  it("reports an impossible server state as an internal error", async () => {
    h.handlers.rpc = () => rpcFails("23514");
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INTERNAL_ERROR");
  });

  // Spec §8.2: a network failure is an item-level INTERNAL_ERROR, not an
  // escaped exception — the envelope stays ok because the call itself worked.
  it("reports a thrown RPC failure as an item-level internal error", async () => {
    h.handlers.rpc = () => {
      throw new Error("network down");
    };
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INTERNAL_ERROR");
  });

  it("maps WORKSPACE_REQUIRED to FORBIDDEN without reserving", async () => {
    h.handlers.identityFailure = "WORKSPACE_REQUIRED";
    const result = await reserveUpload([validPdf]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(h.rpcCalls).toBe(0);
  });

  it("reserves a Markdown item declared as text/plain and sends text/markdown", async () => {
    let seen: Record<string, unknown> = {};
    h.handlers.rpc = (_name, args) => {
      seen = args;
      return { data: `${WORKSPACE_A}/d/v/original.md`, error: null };
    };
    const result = await reserveUpload([
      {
        ...validPdf,
        fileName: "n.md",
        declaredMimeType: "text/plain",
        signature: Buffer.from("# Runboo", "utf8").toString("base64"),
      },
    ]);
    expect(result.ok).toBe(true);
    expect(seen.p_extension).toBe("md");
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    if (outcome.ok) expect(outcome.canonicalMimeType).toBe("text/markdown");
  });
});

describe("finalizeUpload", () => {
  const found = (size: number) => ({
    data: [{ name: "original.md", size }],
    error: null,
  });

  it("confirms an object that exists with the recorded size", async () => {
    h.handlers.version = versionRow(11);
    h.handlers.storageList = () => found(11);
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].versionId).toBe(VER_A);
    expect(result.data[0].outcome.ok).toBe(true);
    if (result.data[0].outcome.ok) {
      expect(result.data[0].outcome.processingStatus).toBe("uploaded");
    }
  });

  it("lists the parent prefix, never the whole bucket", async () => {
    let listedPath = "";
    h.handlers.version = versionRow(11);
    h.handlers.storageList = (path) => {
      listedPath = path;
      return found(11);
    };
    await finalizeUpload([VER_A]);
    expect(listedPath).toBe(`${WORKSPACE_A}/${DOC_A}/${VER_A}`);
  });

  // Review Focus #3: an object of a different size than reserved is not confirmed.
  it("rejects an object whose size differs from the recorded one", async () => {
    h.handlers.version = versionRow(11);
    h.handlers.storageList = () => found(7);
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a missing object", async () => {
    h.handlers.version = versionRow(11);
    h.handlers.storageList = () => ({ data: [], error: null });
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INVALID_INPUT");
  });

  it("compares existence only when no size was recorded", async () => {
    h.handlers.version = versionRow(null);
    h.handlers.storageList = () => found(999);
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].outcome.ok).toBe(true);
  });

  it("reports a version of another tenant as not found", async () => {
    h.handlers.version = null;
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("NOT_FOUND");
  });

  it("rejects a malformed id before touching the database", async () => {
    const result = await finalizeUpload(["not-a-uuid"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a repeated id in one call", async () => {
    const result = await finalizeUpload([VER_A, VER_A]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects a Member at the envelope, before reading anything", async () => {
    h.handlers.actor = { ...adminActor(), role: "Member" };
    let storageCalls = 0;
    h.handlers.storageList = () => {
      storageCalls += 1;
      return { data: [], error: null };
    };
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(storageCalls).toBe(0);
  });

  it("maps an unresolvable session to UNAUTHENTICATED, not FORBIDDEN", async () => {
    h.handlers.actor = null;
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHENTICATED");
  });

  // Decision B2.3: onboarding (signed in, no workspace) is FORBIDDEN, never
  // INTERNAL_ERROR — it is a normal account state, not a defect, so it must
  // not reach Sentry.
  it("maps WORKSPACE_REQUIRED to FORBIDDEN", async () => {
    h.handlers.identityFailure = "WORKSPACE_REQUIRED";
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  // Spec §8.2: a network failure is a per-version INTERNAL_ERROR, not an
  // escaped exception.
  it("reports a thrown storage failure as a per-version internal error", async () => {
    h.handlers.version = versionRow(11);
    h.handlers.storageList = () => {
      throw new Error("network down");
    };
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.data[0].outcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("INTERNAL_ERROR");
  });

  it("writes nothing: the only writes available are the ones RLS forbids", async () => {
    h.handlers.version = versionRow(11);
    h.handlers.storageList = () => found(11);
    const result = await finalizeUpload([VER_A]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].outcome.ok).toBe(true);
  });
});

describe("public surface", () => {
  it("exposes the actions through the module index", async () => {
    const index = await import("@/modules/ingestion");
    expect(index.reserveUpload).toBe(reserveUpload);
    expect(index.finalizeUpload).toBe(finalizeUpload);
    expect(typeof index.startProcessing).toBe("function");
  });
});
