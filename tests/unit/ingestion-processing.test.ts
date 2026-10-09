import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  captureOperationFailure: vi.fn(),
  download: vi.fn(),
  parse: vi.fn(),
  chunk: vi.fn(),
  embed: vi.fn(),
  single: vi.fn(),
  maybeSingle: vi.fn(),
  updateEq: vi.fn(),
  updateSelect: vi.fn(),
  rpc: vi.fn(),
  abortSignals: [] as AbortSignal[],
  rowResult: { data: null as unknown, error: null as unknown },
  fromTables: [] as string[],
}));

vi.mock("@/lib/observability/operation-events", () => ({
  captureOperationFailure: mocks.captureOperationFailure,
}));

vi.mock("@/modules/ingestion/storage", () => ({
  downloadStorageObject: mocks.download,
}));

vi.mock("@/modules/ingestion/chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/ingestion/chunking")>();
  return { ...actual, parseDocument: mocks.parse, chunkDeterministic: mocks.chunk };
});

vi.mock("@/modules/ingestion/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/ingestion/embeddings")>();
  return { ...actual, embedBatch: mocks.embed };
});

vi.mock("@/lib/supabase/service", () => {
  const makeAbortable = (promise: Promise<unknown>) => {
    const query = {
      abortSignal: vi.fn((signal: AbortSignal) => {
        mocks.abortSignals.push(signal);
        return query;
      }),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        promise.then(resolve, reject),
    };
    return query;
  };
  const makeReadQuery = () => {
    const query = {
      eq: vi.fn(() => query),
      abortSignal: vi.fn((signal: AbortSignal) => {
        mocks.abortSignals.push(signal);
        return query;
      }),
      single: () => vi.mocked(mocks.single)(),
      maybeSingle: () => vi.mocked(mocks.maybeSingle)(),
    };
    return query;
  };
  return {
    createServiceClient: () => ({
      from: (table: string) => {
        mocks.fromTables.push(table);
        return {
          select: () => makeReadQuery(),
          update: () => {
            const query = {
              eq: vi.fn((...args: unknown[]) => {
                mocks.updateEq(...args);
                return query;
              }),
              select: (...args: unknown[]) => makeAbortable(
                Promise.resolve(mocks.updateSelect(...args)),
              ),
            };
            return query;
          },
        };
      },
      rpc: (...args: unknown[]) => makeAbortable(Promise.resolve(mocks.rpc(...args))),
    }),
  };
});

import { runProcessing } from "@/modules/ingestion/processing";
import { ParseError } from "@/modules/ingestion/chunking";
import { EmbeddingError } from "@/modules/ingestion/embeddings";

const VERSION_ID = "30000000-0000-4000-8000-000000000010";
const OPERATION_ID = "60000000-0000-4000-8000-000000000010";
const STORAGE_PATH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000010/30000000-0000-4000-8000-000000000010/original.md";

const claimedRow = (overrides: Record<string, unknown> = {}) => ({
  id: VERSION_ID,
  workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  document_id: "20000000-0000-4000-8000-000000000010",
  storage_path: STORAGE_PATH,
  processing_status: "processing",
  processing_operation_id: OPERATION_ID,
  processing_started_at: new Date().toISOString(),
  upload_state: "confirmed",
  ...overrides,
});

const draft = (text_content: string) => ({
  chunk_index: 0,
  text_content,
  page_number: null,
  section_heading: "Title",
});

beforeEach(() => {
  mocks.captureOperationFailure.mockReset();
  mocks.fromTables.length = 0;
  mocks.abortSignals.length = 0;
  mocks.single.mockReset().mockImplementation(async () => ({ data: claimedRow(), error: null }));
  mocks.maybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  mocks.updateEq.mockReset();
  mocks.updateSelect.mockReset().mockResolvedValue({ data: [{ id: VERSION_ID }], error: null });
  mocks.rpc.mockReset().mockResolvedValue({ error: null });
  mocks.download
    .mockReset()
    .mockResolvedValue(new Response("hello world"));
  mocks.parse
    .mockReset()
    .mockResolvedValue({ sections: [{ heading: "Title", page: null, paragraphs: ["hello world"] }] });
  mocks.chunk.mockReset().mockImplementation(() => [draft("hello world")]);
  mocks.embed.mockReset().mockResolvedValue(["[0.5]"]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("runProcessing happy path", () => {
  it("downloads, parses, chunks, embeds and closes with finish_processing", async () => {
    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.download).toHaveBeenCalledWith(STORAGE_PATH, expect.any(AbortSignal));
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(mocks.chunk).toHaveBeenCalledOnce();
    expect(mocks.embed).toHaveBeenCalledWith(["hello world"], expect.objectContaining({
      signal: expect.any(AbortSignal),
      assertCanStart: expect.any(Function),
    }));
    expect(mocks.rpc).toHaveBeenCalledWith("finish_processing", {
      p_version_id: VERSION_ID,
      p_operation_id: OPERATION_ID,
      p_chunks: [
        {
          chunk_index: 0,
          text_content: "hello world",
          page_number: null,
          section_heading: "Title",
          embedding: "[0.5]",
        },
      ],
    });
    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
    expect(mocks.updateEq).not.toHaveBeenCalled();
  });
});

describe("runProcessing parsing failures", () => {
  it("maps NO_TEXT to PARSING_FAILED and marks processing_failed", async () => {
    mocks.parse.mockRejectedValue(new ParseError("NO_TEXT", "empty"));

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith({
      module: "ingestion",
      operation: "process",
      code: "PARSING_FAILED",
      correlationId: expect.any(String),
      versionId: VERSION_ID,
    });
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
  });

  it("maps an unsupported storage extension to PARSING_FAILED without downloading", async () => {
    mocks.single.mockResolvedValue({
      data: claimedRow({ storage_path: STORAGE_PATH.replace(/\.md$/, ".txt") }),
      error: null,
    });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PARSING_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
  });
});

describe("runProcessing chunking failures", () => {
  it("maps an empty chunk set to CHUNKING_FAILED", async () => {
    mocks.chunk.mockReturnValue([]);

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CHUNKING_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("maps more than 500 chunks to CHUNKING_FAILED", async () => {
    mocks.chunk.mockReturnValue(Array.from({ length: 501 }, (_, i) => ({ ...draft(`c${i}`), chunk_index: i })));

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CHUNKING_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("maps a chunk-limit ParseError to CHUNKING_FAILED", async () => {
    mocks.chunk.mockImplementation(() => {
      throw new ParseError("CHUNK_LIMIT_EXCEEDED", "too many");
    });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "CHUNKING_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
  });
});

describe("runProcessing embedding failures", () => {
  it("maps an EmbeddingError to EMBEDDING_FAILED", async () => {
    mocks.embed.mockRejectedValue(new EmbeddingError());

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EMBEDDING_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps an embedding count mismatch to EMBEDDING_FAILED", async () => {
    mocks.embed.mockResolvedValue(["[0.5]", "[0.6]"]);

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EMBEDDING_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("runProcessing persistence failures", () => {
  it("maps an RPC rejection to PERSISTENCE_FAILED", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "private rpc detail", code: "22023" } });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PERSISTENCE_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
  });

  it("maps a null download to PERSISTENCE_FAILED", async () => {
    mocks.download.mockResolvedValue(null);

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PERSISTENCE_FAILED" }),
    );
    expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
    expect(mocks.parse).not.toHaveBeenCalled();
  });

  it("maps a missing version row to PERSISTENCE_FAILED", async () => {
    mocks.single.mockResolvedValue({ data: null, error: null });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PERSISTENCE_FAILED" }),
    );
  });

  it("aborts the download at the claim work deadline and reports PROCESSING_FAILED", async () => {
    mocks.download.mockImplementation(
      (_path: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    vi.useFakeTimers();
    try {
      const pending = runProcessing(VERSION_ID, OPERATION_ID);
      await vi.advanceTimersByTimeAsync(50_000);
      await pending;

      expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
        expect.objectContaining({ code: "PROCESSING_FAILED" }),
      );
      expect(mocks.updateEq).toHaveBeenCalledWith("id", VERSION_ID);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runProcessing guards and guarantees", () => {
  it("returns silently when another worker already moved the version", async () => {
    mocks.single.mockResolvedValue({ data: claimedRow({ processing_status: "ready" }), error: null });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
    expect(mocks.updateEq).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("returns silently when this operation was superseded before the worker started", async () => {
    mocks.single.mockResolvedValue({
      data: claimedRow({ processing_operation_id: "60000000-0000-4000-8000-000000000011" }),
      error: null,
    });

    await runProcessing(VERSION_ID, OPERATION_ID, "retry");

    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("tags technical retry failures as retry after persisting failure state", async () => {
    mocks.parse.mockRejectedValue(new ParseError("NO_TEXT", "private parser detail"));

    await runProcessing(VERSION_ID, OPERATION_ID, "retry");

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      operation: "retry",
      code: "PARSING_FAILED",
      versionId: VERSION_ID,
    }));
    expect(mocks.updateEq).toHaveBeenCalledWith("processing_operation_id", OPERATION_ID);
    expect(mocks.updateSelect).toHaveBeenCalledWith("id");
  });

  it("preserves the controlled result when retry telemetry throws after failure persistence", async () => {
    mocks.parse.mockRejectedValue(new ParseError("NO_TEXT", "private parser detail"));
    mocks.captureOperationFailure.mockImplementation(() => {
      throw new Error("SENTRY_TRANSPORT_SENTINEL");
    });

    await expect(runProcessing(VERSION_ID, OPERATION_ID, "retry")).resolves.toBeUndefined();

    expect(mocks.updateSelect).toHaveBeenCalledWith("id");
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      operation: "retry",
      code: "PARSING_FAILED",
      versionId: VERSION_ID,
    }));
  });

  it("returns silently when the upload was never confirmed", async () => {
    mocks.single.mockResolvedValue({ data: claimedRow({ upload_state: "pending" }), error: null });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
    expect(mocks.updateEq).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("never throws, even when the failure marker itself fails", async () => {
    mocks.rpc.mockRejectedValue(new Error("total rpc explosion"));
    mocks.updateEq.mockRejectedValue(new Error("total db explosion"));

    await expect(runProcessing(VERSION_ID, OPERATION_ID)).resolves.toBeUndefined();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PERSISTENCE_FAILED" }),
    );
  });

  it("never leaks document text through the failure event", async () => {
    mocks.parse.mockRejectedValue(new ParseError("NO_TEXT", "empty"));

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(JSON.stringify(mocks.captureOperationFailure.mock.calls)).not.toMatch(/hello world/i);
  });

  it("stops parse that returns after the persisted claim's work budget", async () => {
    vi.useFakeTimers();
    const workerEnteredAt = Date.parse("2026-10-08T12:00:40.000Z");
    vi.setSystemTime(workerEnteredAt);
    mocks.single.mockResolvedValue({
      data: claimedRow({ processing_started_at: new Date(workerEnteredAt - 40_000).toISOString() }),
      error: null,
    });
    mocks.parse.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return { sections: [{ heading: "Title", page: null, paragraphs: ["late parse"] }] };
    });

    const pending = runProcessing(VERSION_ID, OPERATION_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "PROCESSING_FAILED",
      versionId: VERSION_ID,
    }));
    expect(mocks.updateEq).toHaveBeenCalledWith("processing_operation_id", OPERATION_ID);
  });

  it("aborts embedding work when the claim's work budget expires", async () => {
    vi.useFakeTimers();
    const workerEnteredAt = Date.parse("2026-10-08T12:00:44.000Z");
    vi.setSystemTime(workerEnteredAt);
    mocks.single.mockResolvedValue({
      data: claimedRow({ processing_started_at: new Date(workerEnteredAt - 44_000).toISOString() }),
      error: null,
    });
    mocks.embed.mockImplementation((_texts: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));

    const pending = runProcessing(VERSION_ID, OPERATION_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(mocks.embed).toHaveBeenCalledOnce();
    expect(mocks.embed).toHaveBeenCalledWith(["hello world"], expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "PROCESSING_FAILED",
      versionId: VERSION_ID,
    }));
  });

  it("fails closed when the persisted claim timestamp is invalid", async () => {
    mocks.single.mockResolvedValue({ data: claimedRow({ processing_started_at: null }), error: null });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "PERSISTENCE_FAILED",
      versionId: VERSION_ID,
    }));
  });

  it("reconciles a lost completion response that committed ready and active", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "transport lost after commit" } });
    mocks.maybeSingle
      .mockResolvedValueOnce({
        data: claimedRow({ processing_status: "ready", version_status: "active", processing_operation_id: null }),
        error: null,
      })
      .mockResolvedValueOnce({ data: { active_version_id: VERSION_ID }, error: null });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    expect(mocks.updateEq).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
  });

  it("does not change a replacement claim after a lost completion response", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "transport lost" } });
    mocks.maybeSingle.mockResolvedValueOnce({
      data: claimedRow({ processing_operation_id: "60000000-0000-4000-8000-000000000011" }),
      error: null,
    });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.updateEq).not.toHaveBeenCalled();
    expect(mocks.captureOperationFailure).not.toHaveBeenCalled();
  });

  it("reports persistence failure without claiming a successful mark when the database is unavailable", async () => {
    mocks.single.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    mocks.updateSelect.mockResolvedValue({ data: null, error: { message: "database unavailable" } });

    await runProcessing(VERSION_ID, OPERATION_ID);

    expect(mocks.captureOperationFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "PERSISTENCE_FAILED",
      versionId: VERSION_ID,
    }));
  });
});
