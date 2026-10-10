import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { repositoryQuerySchema } from "../../src/modules/repository/schemas";
import {
  createDocumentSignedUrl,
  escapeLikeLiteral,
  findRepositoryDocuments,
} from "../../src/modules/repository/infrastructure/repository.repository";

function queryBuilder(result: { data: unknown[]; error: null; count: number }) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "order", "range", "ilike", "eq", "is"]) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    });
  }
  builder.then = (resolve: (value: typeof result) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { builder, calls };
}

describe("Repository query validation and literal filters", () => {
  it("defaults pagination, trims names, and distinguishes explicit null from omitted filters", () => {
    expect(repositoryQuerySchema.parse({ name: "  Security  " })).toEqual({
      name: "Security",
      page: 1,
      pageSize: 25,
    });
    expect(repositoryQuerySchema.parse({ ownerId: null, versionStatus: null })).toMatchObject({
      ownerId: null,
      versionStatus: null,
      page: 1,
      pageSize: 25,
    });
  });

  it("rejects malformed, unknown, and overflowing query values without coercion", () => {
    for (const query of [
      { page: "2" },
      { page: Number.NaN },
      { page: Number.POSITIVE_INFINITY },
      { page: Number.MAX_SAFE_INTEGER },
      { pageSize: 0 },
      { name: "x".repeat(201) },
      { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { versionStatus: "uploaded" },
    ]) expect(repositoryQuerySchema.safeParse(query).success).toBe(false);
  });

  it("escapes Postgres LIKE metacharacters before partial case-insensitive search", async () => {
    const result = { data: [], error: null, count: 0 };
    const { builder, calls } = queryBuilder(result);
    const client = { from: vi.fn(() => builder) };
    const search = "100%_\\guide";

    await findRepositoryDocuments(client as never, { name: search });

    expect(escapeLikeLiteral(search)).toBe("100\\%\\_\\\\guide");
    expect(calls).toContainEqual(["ilike", ["name", "%100\\%\\_\\\\guide%"]]);
    expect(calls).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(calls).toContainEqual(["order", ["id", { ascending: false }]]);
  });

  it("applies explicit NULL to the latest projection and uses a bounded exact-count page", async () => {
    const result = { data: [], error: null, count: 0 };
    const { builder, calls } = queryBuilder(result);
    const client = { from: vi.fn(() => builder) };

    await findRepositoryDocuments(client as never, {
      category: "Policy",
      ownerId: null,
      versionStatus: null,
      page: 2,
      pageSize: 10,
    });

    expect(client.from).toHaveBeenCalledWith("repository_documents");
    expect(calls).toContainEqual(["is", ["owner_id", null]]);
    expect(calls).toContainEqual(["is", ["latest_version_status", null]]);
    expect(calls).toContainEqual(["range", [10, 19]]);
    expect(calls.find(([name]) => name === "select")?.[1]).toContainEqual({ count: "exact" });
    expect(calls.find(([name]) => name === "select")?.[1]?.[0]).toContain("latest_processing_started_at");
  });

  it("requests a five-minute signed URL and reports an approximately 300-second expiry", async () => {
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.example/signed-original" },
      error: null,
    });
    const client = { storage: { from: vi.fn(() => ({ createSignedUrl })) } };
    const startedAt = Date.now();

    const result = await createDocumentSignedUrl(
      client as never,
      "workspace/document/version/original.md",
      300,
    );

    expect(result?.url).toBe("https://storage.example/signed-original");
    expect(createSignedUrl).toHaveBeenCalledWith("workspace/document/version/original.md", 300);
    const remainingMs = Date.parse(result!.expiresAt) - Date.now();
    expect(remainingMs).toBeLessThanOrEqual(300_000);
    expect(remainingMs).toBeGreaterThanOrEqual(299_000);
    expect(Date.parse(result!.expiresAt)).toBeGreaterThan(startedAt);
  });
});
