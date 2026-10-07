import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  captureOperationFailure: vi.fn(),
  download: vi.fn(),
  parse: vi.fn(),
  chunk: vi.fn(),
  embed: vi.fn(),
  single: vi.fn(),
  updateEq: vi.fn(),
  updateSelect: vi.fn(),
  rpc: vi.fn(),
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

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      mocks.fromTables.push(table);
      return {
        select: () => ({ eq: () => ({ single: mocks.single }) }),
        update: () => ({ eq: mocks.updateEq }),
      };
    },
    rpc: (...args: unknown[]) => mocks.rpc(...args),
  }),
}));

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
  mocks.single.mockReset().mockResolvedValue({ data: claimedRow(), error: null });
  mocks.updateEq.mockReset().mockImplementation(() => ({
    eq: mocks.updateEq,
    select: mocks.updateSelect,
  }));
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
    expect(mocks.embed).toHaveBeenCalledWith(["hello world"]);
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

  it("aborts the download on timeout and reports PERSISTENCE_FAILED", async () => {
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
        expect.objectContaining({ code: "PERSISTENCE_FAILED" }),
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
});
