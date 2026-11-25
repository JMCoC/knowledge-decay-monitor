import { beforeAll, describe, expect, it } from "vitest";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { createCorrectionFixture, type CorrectionFixture } from "../support/correction-fixtures";
import { createTestWorker } from "../support/ingestion-worker";

beforeAll(assertLocalSupabaseReady);

async function assertRealEmbeddings(fixture: CorrectionFixture) {
  const chunks = await fixture.service.from("document_chunks")
    .select("embedding").eq("version_id", fixture.candidateVersionId);
  expect(chunks.error).toBeNull();
  expect(chunks.data?.length ?? 0).toBeGreaterThan(0);
  for (const row of chunks.data ?? []) {
    const vector = JSON.parse(row.embedding) as number[];
    expect(vector).toHaveLength(384);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 4);
  }
}

function largeFixtureContent() {
  return `# Synthetic correction candidate\n\n${Array.from(
    { length: 120 },
    (_value, index) => `## Section ${index + 1}\n\nA deliberately long local correction paragraph ${index + 1} for real worker fencing.`,
  ).join("\n\n")}\n`;
}

describe("durable correction candidate worker", () => {
  it("processes a correction candidate without activating it", async () => {
    const fixture = await createCorrectionFixture();
    const worker = await createTestWorker();
    try {
      expect(await fixture.readJobState()).toMatchObject({ status: "queued" });
      await worker.start();
      await expect.poll(async () => (await fixture.readFlowState()).processingStatus, {
        timeout: 60_000,
        interval: 100,
      }).toBe("ready");

      const flow = await fixture.readFlowState();
      expect(flow).toMatchObject({
        processingStatus: "ready",
        versionStatus: "pending_approval",
        candidateStatus: "pending_approval",
        roundStatus: "pending_approval",
        activeVersionId: fixture.activeVersionId,
      });
      expect((await fixture.readJobState()).status).toBe("completed");
      await assertRealEmbeddings(fixture);
    } finally {
      await worker.stop();
      await fixture.dispose();
    }
  }, 90_000);

  it("retries a failed candidate on the same version and original without credits or analysis", async () => {
    const fixture = await createCorrectionFixture({ state: "candidate_failed" });
    const worker = await createTestWorker();
    try {
      const failed = await fixture.readFlowState();
      expect(failed).toMatchObject({
        processingStatus: "processing_failed",
        versionStatus: null,
        candidateStatus: "failed",
        roundStatus: "candidate_failed",
        activeVersionId: fixture.activeVersionId,
      });
      const creditsBefore = await fixture.readCreditSnapshot();
      const versionsBefore = failed.versionCount;
      const enqueue = await fixture.service.rpc("enqueue_ingestion_job", {
        p_workspace_id: fixture.workspaceId,
        p_version_id: fixture.candidateVersionId,
        p_retry: true,
      });
      expect(enqueue.error).toBeNull();
      expect(enqueue.data).toBe("queued");
      expect(await fixture.readFlowState()).toMatchObject({
        processingStatus: "uploaded",
        candidateStatus: "selected",
        roundStatus: "candidate_processing",
      });

      await worker.start();
      await expect.poll(async () => (await fixture.readFlowState()).processingStatus, {
        timeout: 60_000,
        interval: 100,
      }).toBe("ready");

      const flow = await fixture.readFlowState();
      expect(flow).toMatchObject({
        processingStatus: "ready",
        versionStatus: "pending_approval",
        candidateStatus: "pending_approval",
        roundStatus: "pending_approval",
        activeVersionId: fixture.activeVersionId,
        versionCount: versionsBefore,
      });
      expect((await fixture.readJobState()).status).toBe("completed");
      const persisted = await fixture.service.from("document_versions")
        .select("storage_path").eq("id", fixture.candidateVersionId).single();
      expect(persisted.error).toBeNull();
      expect(persisted.data?.storage_path).toBe(fixture.storagePath);
      expect(await fixture.readCreditSnapshot()).toEqual(creditsBefore);
      await assertRealEmbeddings(fixture);
    } finally {
      await worker.stop();
      await fixture.dispose();
    }
  }, 90_000);

  it("fences the old worker when a replacement claim takes over the candidate", async () => {
    const fixture = await createCorrectionFixture({ content: largeFixtureContent() });
    const workerA = await createTestWorker();
    let workerB: Awaited<ReturnType<typeof createTestWorker>> | undefined;
    try {
      await workerA.start();
      await expect.poll(async () => (await fixture.readJobState()).status, {
        timeout: 60_000,
        interval: 25,
      }).toBe("running");
      const operationA = (await fixture.readJobState()).operationId;
      expect(operationA).toBeTruthy();
      await workerA.stop(true);
      expect((await fixture.readJobState()).status).toBe("running");
      await fixture.expireLease();

      workerB = await createTestWorker();
      await workerB.start();
      await expect.poll(async () => (await fixture.readFlowState()).processingStatus, {
        timeout: 60_000,
        interval: 100,
      }).toBe("ready");

      const job = await fixture.readJobState();
      expect(job.status).toBe("completed");
      expect(job.operationId).not.toBe(operationA);
      expect(job.attemptCount).toBe(2);
      const flow = await fixture.readFlowState();
      expect(flow).toMatchObject({
        processingStatus: "ready",
        versionStatus: "pending_approval",
        candidateStatus: "pending_approval",
        roundStatus: "pending_approval",
        activeVersionId: fixture.activeVersionId,
      });
      await assertRealEmbeddings(fixture);
    } finally {
      await workerA.stop(true).catch(() => undefined);
      if (workerB) await workerB.stop().catch(() => undefined);
      await fixture.dispose();
    }
  }, 120_000);
});
