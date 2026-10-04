import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { loginAs } from "./auth.helper";
import { setLocalUploadMode } from "../support/local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const UPLOADED_LABEL = "Uploaded — processing pending";

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function cleanupDocuments(names: string[]) {
  if (names.length === 0) return;
  const service = serviceClient();
  const docs = await service.from("documents").select("id").in("name", names);
  if (docs.error) throw new Error("Could not inspect synthetic upload documents for cleanup.");
  const documentIds = docs.data.map((document) => document.id);
  if (documentIds.length === 0) return;

  const versions = await service.from("document_versions").select("id,storage_path")
    .in("document_id", documentIds);
  if (versions.error) throw new Error("Could not inspect synthetic upload versions for cleanup.");
  const versionIds = versions.data.map((version) => version.id);
  let attemptPaths: string[] = [];
  if (versionIds.length > 0) {
    const attempts = await service.from("document_upload_attempts").select("storage_path").in("version_id", versionIds);
    if (attempts.error) throw new Error("Could not inspect synthetic upload attempts for cleanup.");
    attemptPaths = attempts.data.map((attempt) => attempt.storage_path);
  }
  const paths = [
    ...versions.data.map((version) => version.storage_path),
    ...attemptPaths,
  ];
  if (paths.length > 0) {
    const { error } = await service.storage.from("documents").remove(paths);
    if (error) throw new Error("Could not remove synthetic local Storage objects.");
  }
  const removed = await service.from("documents").delete().in("id", documentIds);
  if (removed.error) throw new Error("Could not remove synthetic local upload rows.");
}

test.describe("Repository upload", () => {
  // These E2E cases share the database-backed upload mode flag, so fullyParallel is unsafe here.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => setLocalUploadMode("active"));
  test.afterAll(() => setLocalUploadMode("paused"));

  test.beforeEach(async ({ context }) => {
    await loginAs(context, "admin.a@example.test");
  });

  test("Admin can select supported files and sees required metadata fields", async ({ page }) => {
    await page.goto("/repository");

    await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Upload documents" })).toBeVisible();
    await expect(page.getByLabel("Choose PDF, DOCX, or Markdown files")).toHaveAttribute("type", "file");
    await page.getByLabel("Choose PDF, DOCX, or Markdown files").setInputFiles({
      name: "guide.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("a"),
    });
    await expect(page.getByLabel("Category").first()).toBeVisible();
    await expect(page.getByLabel("Owner").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload files" })).toBeVisible();
  });

  test("rejects more than ten files before starting a transfer", async ({ page }) => {
    await page.goto("/repository");
    const files = Array.from({ length: 11 }, (_, index) => ({
      name: `guide-${index}.md`,
      mimeType: "text/markdown",
      buffer: Buffer.from("a"),
    }));

    await page.getByLabel("Choose PDF, DOCX, or Markdown files").setInputFiles(files);

    await expect(page.getByText("Choose between 1 and 10 files.", { exact: true })).toBeVisible();
  });

  test("rejects a file larger than 10 MiB before enabling upload", async ({ page }) => {
    await page.goto("/repository");
    await page.getByLabel("Choose PDF, DOCX, or Markdown files").setInputFiles({
      name: "oversized.md",
      mimeType: "text/markdown",
      buffer: Buffer.alloc(10_485_761, 97),
    });

    await expect(page.getByText("Each file must be 10 MiB or smaller.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload files" })).toBeDisabled();
  });

  test("another QA in the same workspace resumes an interrupted upload", async ({ page }) => {
    const documentName = `S1-02 cross-session ${randomUUID()}`;
    const fileName = "cross-session.md";
    const bytes = Buffer.from("the exact original bytes can be resumed by another QA");
    let interruptedTransfers = 0;
    const service = serviceClient();

    await page.route(`${LOCAL_API_URL}/storage/v1/object/documents/**`, async (route) => {
      if (route.request().method() === "POST" && interruptedTransfers < 2) {
        interruptedTransfers += 1;
        await route.abort();
        return;
      }
      await route.continue();
    });

    try {
      await page.goto("/repository");
      await page.getByLabel("Choose PDF, DOCX, or Markdown files").setInputFiles({
        name: fileName,
        mimeType: "text/markdown",
        buffer: bytes,
      });
      await page.getByLabel("Document name").fill(documentName);
      await page.getByLabel("Category").selectOption("SOP");
      await page.getByRole("button", { name: "Upload files" }).click();
      const uploadRegion = page.getByRole("region", { name: "Upload documents" });
      await expect(uploadRegion.getByText("Upload incomplete", { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(interruptedTransfers).toBe(2);

      const { data: document, error: documentError } = await service.from("documents")
        .select("id")
        .eq("name", documentName)
        .single();
      expect(documentError).toBeNull();
      if (!document) throw new Error("The interrupted upload was not reserved.");
      const { data: pendingVersion, error: versionError } = await service.from("document_versions")
        .select("id,upload_state,storage_path")
        .eq("document_id", document.id)
        .single();
      expect(versionError).toBeNull();
      expect(pendingVersion?.upload_state).toBe("pending");

      await page.unroute(`${LOCAL_API_URL}/storage/v1/object/documents/**`);
      await page.context().clearCookies();
      await loginAs(page.context(), "qa.a@example.test");
      await page.goto("/repository");

      const row = page.getByRole("row").filter({ hasText: documentName });
      const resumeButton = row.getByRole("button", { name: "Recover upload" });
      await expect(resumeButton).toBeVisible();
      await resumeButton.click();
      const resumeInput = row.getByLabel("Select original file");
      await expect(resumeInput).toHaveAttribute("type", "file");
      await resumeInput.setInputFiles({ name: fileName, mimeType: "text/markdown", buffer: bytes });

      await expect(row.getByText(UPLOADED_LABEL, { exact: true })).toBeVisible({ timeout: 30_000 });
      const { data: confirmedVersion, error: confirmedError } = await service.from("document_versions")
        .select("id,upload_state,storage_path")
        .eq("id", pendingVersion?.id ?? "")
        .single();
      expect(confirmedError).toBeNull();
      expect(confirmedVersion?.upload_state).toBe("confirmed");
      const canonical = await service.storage.from("documents").download(
        confirmedVersion?.storage_path ?? "",
      );
      expect(canonical.error).toBeNull();
      if (!canonical.data) throw new Error("The second QA did not publish the original bytes.");
      expect(new Uint8Array(await canonical.data.arrayBuffer())).toEqual(bytes);
    } finally {
      await page.unroute(`${LOCAL_API_URL}/storage/v1/object/documents/**`);
      await cleanupDocuments([documentName]);
    }
  });

  test("uploads ten files and a 10 MiB file through Storage while Next.js receives only metadata", async ({ page }) => {
    const suffix = randomUUID();
    const batchNames = Array.from({ length: 10 }, (_, index) => `S1-02 batch ${suffix} ${index}`);
    const maxFileName = `S1-02 limit ${suffix}`;
    const allNames = [...batchNames, maxFileName];
    const appPostBodySizes: number[] = [];
    const appPostObservations: Array<{ path: string; bodyBytes: number }> = [];
    let storageWriteRequestCount = 0;
    const failedRequests: string[] = [];
    const sizeObservations: Promise<void>[] = [];

    page.on("requestfinished", (request) => {
      sizeObservations.push((async () => {
        const url = new URL(request.url());
        const { requestBodySize } = await request.sizes();
        if (url.origin === "http://127.0.0.1:3000" && request.method() === "POST") {
          const postDataSize = request.postDataBuffer()?.byteLength ?? 0;
          const headers = await request.allHeaders();
          const contentLength = Number(headers["content-length"] ?? 0);
          const bodyBytes = Math.max(requestBodySize, postDataSize, contentLength);
          appPostBodySizes.push(bodyBytes);
          appPostObservations.push({ path: url.pathname, bodyBytes });
        }
        if (
          url.origin === LOCAL_API_URL
          && url.pathname.startsWith("/storage/v1/object/documents/")
          && ["POST", "PUT"].includes(request.method())
        ) {
          storageWriteRequestCount += 1;
        }
      })());
    });
    page.on("response", async (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      const boundary = url.origin === LOCAL_API_URL
        ? url.pathname.startsWith("/storage/") ? "storage" : "supabase-api"
        : url.origin === "http://127.0.0.1:3000" ? "next" : "other";
      let detail = "";
      if (boundary === "storage") {
        try {
          const body = await response.json() as Record<string, unknown>;
          const error = typeof body.error === "string" ? body.error.slice(0, 100) : "";
          const statusCode = typeof body.statusCode === "string" ? body.statusCode.slice(0, 20) : "";
          const message = typeof body.message === "string"
            ? body.message.slice(0, 160).replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "[id]")
            : "";
          detail = `:${JSON.stringify({ statusCode, error, message })}`;
        } catch {
          detail = ":unreadable-error-body";
        }
      }
      failedRequests.push(`${boundary}:${response.status()}${detail}`);
    });

    try {
      await page.goto("/repository");
      const fileInput = page.getByLabel("Choose PDF, DOCX, or Markdown files");
      await fileInput.setInputFiles(batchNames.map((name) => ({
        name: `${name}.md`,
        mimeType: "text/markdown",
        buffer: Buffer.from("a"),
      })));
      await expect(page.getByLabel("Document name")).toHaveCount(10);
      for (const [index, name] of batchNames.entries()) {
        await page.getByLabel("Document name").nth(index).fill(name);
        await page.getByLabel("Category").nth(index).selectOption("SOP");
      }
      const batchUpload = page.getByRole("button", { name: "Upload files" });
      await expect(batchUpload).toBeEnabled();
      await batchUpload.click();
      const batchStatuses = page.getByRole("status");
      await expect(batchStatuses).toHaveCount(10, { timeout: 15_000 });
      await expect.poll(async () => (await batchStatuses.allTextContents()).every((status) =>
        !["Preparing", "Uploading", "Verifying", "Recovering"].includes(status),
      ), { timeout: 60_000 }).toBe(true);
      const actualBatchStatuses = await batchStatuses.allTextContents();
      const visibleAlerts = await page.getByRole("alert").allTextContents();
      expect(actualBatchStatuses, JSON.stringify({ statuses: actualBatchStatuses, alerts: visibleAlerts, failedRequests }))
        .toEqual(Array.from({ length: 10 }, () => UPLOADED_LABEL));

      const maximumSizeBytes = Buffer.alloc(MAX_FILE_SIZE_BYTES, 0x61);
      await fileInput.setInputFiles({
        name: `${maxFileName}.md`,
        mimeType: "text/markdown",
        buffer: maximumSizeBytes,
      });
      await expect(page.getByLabel("Document name")).toHaveCount(1);
      await page.getByLabel("Document name").fill(maxFileName);
      await page.getByLabel("Category").selectOption("SOP");
      const maximumSizeUpload = page.getByRole("button", { name: "Upload files" });
      await expect(maximumSizeUpload).toBeEnabled();
      await maximumSizeUpload.click();
      await expect(page.getByText(UPLOADED_LABEL, { exact: true })).toHaveCount(1, { timeout: 60_000 });

      const service = serviceClient();
      const documents = await service.from("documents").select("id,name,active_version_id")
        .in("name", allNames);
      expect(documents.error).toBeNull();
      expect(documents.data).toHaveLength(11);
      expect(documents.data?.every((document) => document.active_version_id === null)).toBe(true);
      const versions = await service.from("document_versions")
        .select("id,document_id,processing_status,version_status,upload_state,storage_path")
        .in("document_id", documents.data?.map((document) => document.id) ?? []);
      expect(versions.error).toBeNull();
      expect(versions.data).toHaveLength(11);
      expect(versions.data?.every((version) =>
        version.processing_status === "uploaded"
        && version.version_status === null
        && version.upload_state === "confirmed",
      )).toBe(true);

      const maximumVersion = versions.data?.find((version) =>
        documents.data?.some((document) => document.id === version.document_id && document.name === maxFileName));
      expect(maximumVersion?.storage_path).toBeTruthy();
      if (!maximumVersion?.storage_path) throw new Error("The 10 MiB upload has no confirmed canonical path.");
      const downloaded = await service.storage.from("documents").download(maximumVersion.storage_path);
      expect(downloaded.error).toBeNull();
      if (!downloaded.data) throw new Error("The 10 MiB canonical original could not be opened.");
      const actualHash = createHash("sha256")
        .update(new Uint8Array(await downloaded.data.arrayBuffer()))
        .digest("hex");
      const expectedHash = createHash("sha256").update(maximumSizeBytes).digest("hex");
      expect(actualHash === expectedHash).toBe(true);

      await Promise.all(sizeObservations);
      expect(appPostBodySizes.length, JSON.stringify({ appPostObservations, failedRequests }))
        .toBeGreaterThan(0);
      expect(Math.max(...appPostBodySizes), JSON.stringify({ appPostObservations, failedRequests }))
        .toBeLessThan(4_500_000);
      expect(storageWriteRequestCount, JSON.stringify({
        storageWriteRequestCount,
        appPostObservations,
        failedRequests,
      })).toBe(11);
    } finally {
      await cleanupDocuments(allNames);
    }
  });
});
