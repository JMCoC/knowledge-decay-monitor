import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page, type Request } from "./fixtures";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { markdownSections } from "../support/processing-inputs";
import { loginAs } from "./auth.helper";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_A_ID = "10000000-0000-4000-8000-000000000001";
const QA_LEAD_A_ID = "10000000-0000-4000-8000-000000000002";
const EMPTY_PDF = readFileSync(resolve("tests/fixtures/processing/pdf-empty/original-empty.pdf"));
const MARKDOWN = Buffer.from([
  "# Retry processing fixture",
  "",
  "This synthetic runbook is used by the local end-to-end retry test. It contains enough text to create a deterministic chunk and exercise the real embedding and persistence pipeline.",
  "",
  "## Recovery",
  "",
  "The on-call engineer records the incident, assigns severity, follows the escalation policy, and documents each recovery action before closing the event.",
].join("\n"), "utf8");

type RetryFixture = {
  name: string;
  documentId: string;
  versionId: string;
  storagePath: string;
  bytes: Buffer;
  sha256: string;
};

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function openOriginalFromUi(page: Page, context: BrowserContext, name: string) {
  await page.goto(`/repository?name=${encodeURIComponent(name)}`);
  const row = page.getByRole("row").filter({ hasText: name });
  const button = row.getByRole("button", { name: `Open file ${name}` });
  await expect(button).toBeVisible();

  const requestPromise = context.waitForEvent("request", {
    predicate: (request: Request) => {
      const url = new URL(request.url());
      return request.method() === "GET"
        && url.origin === LOCAL_API_URL
        && url.pathname.startsWith("/storage/v1/object/sign/documents/");
    },
    timeout: 15_000,
  });
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await button.click();
  const popup = await popupPromise;
  const request = await requestPromise;
  return { popup, request };
}

async function cleanupFixture(name: string) {
  const service = serviceClient();
  const documents = await service.from("documents").select("id").eq("name", name);
  if (documents.error) throw new Error("Could not inspect the synthetic retry document for cleanup.");
  const documentIds = documents.data.map((document) => document.id);
  if (documentIds.length === 0) return;

  const versions = await service.from("document_versions").select("id,storage_path")
    .in("document_id", documentIds);
  if (versions.error) throw new Error("Could not inspect the synthetic retry version for cleanup.");
  const versionIds = versions.data.map((version) => version.id);
  const attempts = versionIds.length > 0
    ? await service.from("document_upload_attempts").select("storage_path").in("version_id", versionIds)
    : { data: [], error: null };
  if (attempts.error) throw new Error("Could not inspect the synthetic retry attempt for cleanup.");

  const paths = [...versions.data.map((version) => version.storage_path), ...attempts.data.map((attempt) => attempt.storage_path)];
  if (paths.length > 0) {
    const removed = await service.storage.from("documents").remove(paths);
    if (removed.error) throw new Error("Could not remove the synthetic retry originals.");
  }
  const removed = await service.from("documents").delete().in("id", documentIds);
  if (removed.error) throw new Error("Could not remove the synthetic retry rows.");
}

async function createRetryFixture(input: {
  label: string;
  ownerId: string;
  extension: "md" | "pdf";
  bytes: Buffer;
  processingStatus?: "uploaded" | "processing_failed" | "processing";
  processingStartedAt?: string;
}): Promise<RetryFixture> {
  const service = serviceClient();
  const suffix = randomUUID();
  const name = `S1-07 Retry ${input.label} ${suffix}`;
  const documentId = randomUUID();
  const versionId = randomUUID();
  const attemptId = randomUUID();
  const storagePath = `${WORKSPACE_A}/${documentId}/${versionId}/original.${input.extension}`;
  const attemptPath = `${WORKSPACE_A}/${documentId}/${versionId}/attempts/${attemptId}/original.${input.extension}`;
  const now = new Date().toISOString();
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  const processingStatus = input.processingStatus ?? "processing_failed";

  try {
    const document = await service.from("documents").insert({
      id: documentId,
      workspace_id: WORKSPACE_A,
      name,
      category: "SOP",
      owner_id: input.ownerId,
    });
    if (document.error) throw new Error("Could not create the synthetic retry document.");

    const version = await service.from("document_versions").insert({
      id: versionId,
      workspace_id: WORKSPACE_A,
      document_id: documentId,
      version_number: 1,
      storage_path: storagePath,
      processing_status: processingStatus,
      processing_operation_id: processingStatus === "processing" ? randomUUID() : null,
      processing_started_at: processingStatus === "processing"
        ? input.processingStartedAt ?? now
        : null,
      version_status: null,
      size_bytes: input.bytes.byteLength,
    });
    if (version.error) throw new Error("Could not create the synthetic failed retry version.");

    const attempt = await service.from("document_upload_attempts").insert({
      id: attemptId,
      workspace_id: WORKSPACE_A,
      version_id: versionId,
      storage_path: attemptPath,
      retired_at: now,
      cleanup_status: "absent",
    });
    if (attempt.error) throw new Error("Could not create the synthetic upload attempt.");

    const confirmed = await service.from("document_versions").update({
      upload_state: "confirmed",
      expected_sha256: digest,
      hash_source: "client_declared",
      upload_initiator_id: input.ownerId,
      idempotency_key: randomUUID(),
      request_fingerprint: digest,
      current_upload_attempt_id: attemptId,
      upload_confirmed_at: now,
      reference_set_at: now,
      reference_set_by: input.ownerId,
    }).eq("id", versionId);
    if (confirmed.error) throw new Error("Could not confirm the synthetic original.");

    const original = await service.storage.from("documents").upload(storagePath, input.bytes, {
      contentType: input.extension === "pdf" ? "application/pdf" : "text/markdown",
      upsert: false,
    });
    if (original.error) throw new Error("Could not store the synthetic retry original.");

    return { name, documentId, versionId, storagePath, bytes: input.bytes, sha256: digest };
  } catch (error) {
    await cleanupFixture(name);
    throw error;
  }
}

async function countDocuments(documentId: string) {
  const service = serviceClient();
  const result = await service.from("documents").select("id", { count: "exact", head: true }).eq("id", documentId);
  if (result.error) throw new Error("Could not verify the synthetic retry result.");
  return result.count ?? 0;
}

async function countVersions(documentId: string) {
  const service = serviceClient();
  const result = await service.from("document_versions").select("id", { count: "exact", head: true })
    .eq("document_id", documentId);
  if (result.error) throw new Error("Could not verify the synthetic retry versions.");
  return result.count ?? 0;
}

async function countChunks(versionId: string) {
  const service = serviceClient();
  const result = await service.from("document_chunks").select("id", { count: "exact", head: true })
    .eq("version_id", versionId);
  if (result.error) throw new Error("Could not verify the synthetic retry chunks.");
  return result.count ?? 0;
}

test.describe("Repository processing retry", () => {
  test("confirmed uploads stay queued until the worker starts and preserve the original", async ({ page, context, ingestionWorker }) => {
    test.setTimeout(120_000);
    await loginAs(context, "admin.a@example.test");
    await ingestionWorker.stop();
    const fixture = await createRetryFixture({
      label: "admin-start",
      ownerId: ADMIN_A_ID,
      extension: "md",
      bytes: MARKDOWN,
      processingStatus: "uploaded",
    });

    try {
      await page.goto(`/repository?name=${encodeURIComponent(fixture.name)}`);
      const row = page.getByRole("row").filter({ hasText: fixture.name });
      await expect(row.getByRole("button", { name: /Open file/i })).toBeVisible();
      await expect(row.getByRole("button", { name: "Start Processing" })).toHaveCount(0);
      await ingestionWorker.start();
      await expect(row.getByText("Ready", { exact: true })).toBeVisible({ timeout: 75_000 });

      const version = await serviceClient().from("document_versions")
        .select("id,storage_path,processing_status,version_status,upload_state,expected_sha256")
        .eq("id", fixture.versionId)
        .single();
      expect(version.error).toBeNull();
      expect(version.data).toMatchObject({
        id: fixture.versionId,
        storage_path: fixture.storagePath,
        processing_status: "ready",
        version_status: "active",
        upload_state: "confirmed",
        expected_sha256: fixture.sha256,
      });
      expect(await countDocuments(fixture.documentId)).toBe(1);
      expect(await countVersions(fixture.documentId)).toBe(1);
      expect(await countChunks(fixture.versionId)).toBeGreaterThan(0);

      const original = await serviceClient().storage.from("documents").download(fixture.storagePath);
      expect(original.error).toBeNull();
      if (!original.data) throw new Error("The started original could not be downloaded.");
      expect(Buffer.from(await original.data.arrayBuffer())).toEqual(fixture.bytes);
    } finally {
      await cleanupFixture(fixture.name);
      await ingestionWorker.start();
    }
  });

  test("refreshes a near-expired lease and retries it without a manual page reload", async ({ page, context }) => {
    test.setTimeout(120_000);
    await loginAs(context, "admin.a@example.test");
    const fixture = await createRetryFixture({
      label: "admin-stale-lease",
      ownerId: ADMIN_A_ID,
      extension: "md",
      bytes: MARKDOWN,
      processingStatus: "processing",
      processingStartedAt: new Date(Date.now() - 170_000).toISOString(),
    });

    try {
      await page.goto(`/repository?name=${encodeURIComponent(fixture.name)}`);
      const row = page.getByRole("row").filter({ hasText: fixture.name });
      const retryButton = row.getByRole("button", { name: "Retry Processing" });
      await expect(retryButton).toHaveCount(0);
      await expect(retryButton).toBeVisible({ timeout: 30_000 });
      await retryButton.click();
      await expect(row.getByText("Ready", { exact: true })).toBeVisible({ timeout: 75_000 });

      const version = await serviceClient().from("document_versions")
        .select("id,storage_path,processing_status,version_status,upload_state,expected_sha256")
        .eq("id", fixture.versionId)
        .single();
      expect(version.error).toBeNull();
      expect(version.data).toMatchObject({
        id: fixture.versionId,
        storage_path: fixture.storagePath,
        processing_status: "ready",
        version_status: "active",
        upload_state: "confirmed",
        expected_sha256: fixture.sha256,
      });
      expect(await countDocuments(fixture.documentId)).toBe(1);
      expect(await countVersions(fixture.documentId)).toBe(1);
      expect(await countChunks(fixture.versionId)).toBeGreaterThan(0);
    } finally {
      await cleanupFixture(fixture.name);
    }
  });

  test("Admin can retry a failed version to ready without replacing its original or duplicating the document", async ({ page, context }) => {
    const fixture = await createRetryFixture({
      label: "admin-success",
      ownerId: ADMIN_A_ID,
      extension: "md",
      bytes: MARKDOWN,
    });

    try {
      await loginAs(context, "admin.a@example.test");
      await page.goto(`/repository?name=${encodeURIComponent(fixture.name)}`);
      const row = page.getByRole("row").filter({ hasText: fixture.name });
      await expect(row.getByText("Processing failed", { exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Retry Processing" }).click();
      await expect(row.getByText("Ready", { exact: true })).toBeVisible({ timeout: 75_000 });

      const version = await serviceClient().from("document_versions")
        .select("id,storage_path,processing_status,version_status,upload_state")
        .eq("id", fixture.versionId)
        .single();
      expect(version.error).toBeNull();
      expect(version.data).toMatchObject({
        id: fixture.versionId,
        storage_path: fixture.storagePath,
        processing_status: "ready",
        version_status: "active",
        upload_state: "confirmed",
      });

      const document = await serviceClient().from("documents").select("active_version_id")
        .eq("id", fixture.documentId).single();
      expect(document.error).toBeNull();
      expect(document.data?.active_version_id).toBe(fixture.versionId);
      expect(await countDocuments(fixture.documentId)).toBe(1);
      expect(await countVersions(fixture.documentId)).toBe(1);
      expect(await countChunks(fixture.versionId)).toBeGreaterThan(0);

      const original = await serviceClient().storage.from("documents").download(fixture.storagePath);
      expect(original.error).toBeNull();
      if (!original.data) throw new Error("The retry original could not be downloaded.");
      expect(Buffer.from(await original.data.arrayBuffer())).toEqual(fixture.bytes);
    } finally {
      await cleanupFixture(fixture.name);
    }
  });

  test("QA Lead can retry a failed version and sees a controlled failure when parsing fails again", async ({ page, context }) => {
    const fixture = await createRetryFixture({
      label: "qa-failure",
      ownerId: QA_LEAD_A_ID,
      extension: "pdf",
      bytes: EMPTY_PDF,
    });

    try {
      await loginAs(context, "qa.a@example.test");
      await page.goto(`/repository?name=${encodeURIComponent(fixture.name)}`);
      const row = page.getByRole("row").filter({ hasText: fixture.name });
      await expect(row.getByRole("button", { name: "Retry Processing" })).toBeVisible();
      await row.getByRole("button", { name: "Retry Processing" }).click();
      await expect(page.getByText("Processing queued.", { exact: true })).toBeVisible();
      await expect.poll(async()=>{
        const result=await serviceClient().from('document_versions').select('processing_status,processing_queued').eq('id',fixture.versionId).single();
        return result.data?.processing_queued ? 'queued' : result.data?.processing_status;
      },{timeout:30_000}).toBe('processing_failed');
      await page.reload();
      await expect(row.getByText("Processing failed", { exact: true })).toBeVisible();

      const version = await serviceClient().from("document_versions")
        .select("id,storage_path,processing_status,version_status,upload_state")
        .eq("id", fixture.versionId)
        .single();
      expect(version.error).toBeNull();
      expect(version.data).toMatchObject({
        id: fixture.versionId,
        storage_path: fixture.storagePath,
        processing_status: "processing_failed",
        version_status: null,
        upload_state: "confirmed",
      });
      expect(await countDocuments(fixture.documentId)).toBe(1);
      expect(await countVersions(fixture.documentId)).toBe(1);
      expect(await countChunks(fixture.versionId)).toBe(0);
    } finally {
      await cleanupFixture(fixture.name);
    }
  });

  test("Member and another workspace cannot see or retry a failed version", async ({ page, context }) => {
    const fixture = await createRetryFixture({
      label: "tenant-denial",
      ownerId: ADMIN_A_ID,
      extension: "pdf",
      bytes: EMPTY_PDF,
    });

    try {
      await loginAs(context, "member.a@example.test");
      await page.goto(`/repository?name=${encodeURIComponent(fixture.name)}`);
      await expect(page.getByText("You don't have permission to access documents.", { exact: true })).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry Processing" })).toHaveCount(0);

      await context.clearCookies();
      await loginAs(context, "admin.b@example.test");
      await page.goto(`/repository?name=${encodeURIComponent(fixture.name)}`);
      await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
      await expect(page.getByText(fixture.name, { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry Processing" })).toHaveCount(0);

      const version = await serviceClient().from("document_versions")
        .select("processing_status,version_status,upload_state")
        .eq("id", fixture.versionId)
        .single();
      expect(version.error).toBeNull();
      expect(version.data).toMatchObject({
        processing_status: "processing_failed",
        version_status: null,
        upload_state: "confirmed",
      });
      expect(await countChunks(fixture.versionId)).toBe(0);
    } finally {
      await cleanupFixture(fixture.name);
    }
  });

  test("a signed original URL expires after five minutes and the UI issues a fresh URL", async ({ page, context }) => {
    test.setTimeout(360_000);
    await loginAs(context, "admin.a@example.test");
    const fixture = await createRetryFixture({
      label: "signed-url-expiry",
      ownerId: ADMIN_A_ID,
      extension: "pdf",
      bytes: EMPTY_PDF,
    });

    try {
      const firstOpen = await openOriginalFromUi(page, context, fixture.name);
      const expiredUrl = firstOpen.request.url();
      const firstResponse = await firstOpen.request.response();
      expect(firstResponse?.status()).toBe(200);
      await firstOpen.popup.close();

      await page.waitForTimeout(300_500);
      let expiredStatus: number;
      try {
        const expiredResponse = await context.request.get(expiredUrl, { timeout: 15_000 });
        expiredStatus = expiredResponse.status();
      } catch {
        throw new Error("The expired local original URL did not return an HTTP response.");
      }
      expect(expiredStatus).toBeGreaterThanOrEqual(400);

      const renewedOpen = await openOriginalFromUi(page, context, fixture.name);
      try {
        const renewedResponse = await renewedOpen.request.response();
        expect(renewedResponse?.status()).toBe(200);
      } finally {
        if (!renewedOpen.popup.isClosed()) await renewedOpen.popup.close();
      }
    } finally {
      await cleanupFixture(fixture.name);
    }
  });

  test("recovers automatically after the worker process is killed", async ({ page, context, ingestionWorker }) => {
    // Allow the actual 180s abandoned lease plus the supported 15min attempt.
    test.setTimeout(1_200_000);
    await ingestionWorker.stop();
    await loginAs(context, "admin.a@example.test");
    const fixture=await createRetryFixture({label:"worker-crash",ownerId:ADMIN_A_ID,extension:"md",bytes:markdownSections(500),processingStatus:"uploaded"});
    try {
      await page.goto(`/repository?name=${encodeURIComponent(fixture.name)}`);
      const row=page.getByRole('row').filter({hasText:fixture.name});
      await expect(row.getByText('Queued',{exact:true})).toBeVisible();
      await ingestionWorker.start();
      await expect.poll(async()=>{
        const result=await serviceClient().from('document_versions').select('processing_status').eq('id',fixture.versionId).single();
        return result.data?.processing_status;
      },{timeout:15_000,intervals:[50,100]}).toBe('processing');
      await ingestionWorker.stop(true);
      const interrupted=await serviceClient().from('document_versions').select('processing_status,processing_operation_id').eq('id',fixture.versionId).single();
      expect(interrupted.data?.processing_status).toBe('processing');
      const oldOperation=interrupted.data?.processing_operation_id;
      expect(oldOperation).toBeTruthy();
      expect(await countChunks(fixture.versionId)).toBe(0);
      await page.reload();
      await expect(row.getByRole('button',{name:'Retry Processing'})).toHaveCount(0);
      await ingestionWorker.start();
      // No manual retry: durable redelivery after real lease expiry must recover the job.
      const recoveryStarted = Date.now();
      await expect.poll(async () => {
        const result = await serviceClient().from('document_versions')
          .select('processing_status,processing_lease_expires_at').eq('id',fixture.versionId).single();
        return result.data?.processing_status === 'ready' ? 'ready' : result.data;
      }, { timeout:180_000 + 15 * 60_000 }).toBe('ready');
      console.info(JSON.stringify({ event:'synthetic_worker_recovery', chunks:500, durationMs:Date.now()-recoveryStarted }));
      await expect(row.getByText('Ready',{exact:true})).toBeVisible({timeout:20_000});
      expect(await countChunks(fixture.versionId)).toBe(500);
      const document=await serviceClient().from('documents').select('active_version_id').eq('id',fixture.documentId).single();
      expect(document.data?.active_version_id).toBe(fixture.versionId);
      const stale=await serviceClient().rpc('finish_processing',{p_version_id:fixture.versionId,p_operation_id:oldOperation!,p_chunks:[]});
      expect(stale.error?.code).toBe('22023');
      expect(await countChunks(fixture.versionId)).toBe(500);
    } finally {
      await cleanupFixture(fixture.name);
      await ingestionWorker.start();
    }
  });
});
