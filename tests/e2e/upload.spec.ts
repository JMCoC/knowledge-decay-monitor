import { expect, test } from "./fixtures";
import { markdownSections } from "../support/processing-inputs";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { loginAs } from "./auth.helper";
import { getLocalUploadMode, setLocalUploadMode } from "../support/local-supabase";

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

  let previousUploadMode: "paused" | "active";
  test.beforeAll(() => {
    previousUploadMode = getLocalUploadMode();
    setLocalUploadMode("active");
  });
  test.afterAll(() => setLocalUploadMode(previousUploadMode));

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
      buffer: markdownSections(32),
    });
    await expect(page.getByRole("region", { name: "Upload documents" }).getByLabel("Category").first()).toBeVisible();
    await expect(page.getByLabel("Owner").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload files" })).toBeVisible();
  });

  test("rejects more than ten files before starting a transfer", async ({ page }) => {
    await page.goto("/repository");
    const files = Array.from({ length: 11 }, (_, index) => ({
      name: `guide-${index}.md`,
      mimeType: "text/markdown",
      buffer: markdownSections(32),
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
      await page.getByRole("region", { name: "Upload documents" }).getByLabel("Category").selectOption("SOP");
      await page.getByRole("button", { name: "Upload files" }).click();
      const uploadRegion = page.getByRole("region", { name: "Upload documents" });
      await expect(uploadRegion.getByText("Upload incomplete", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(uploadRegion.getByRole("alert")).toContainText(
        "We couldn't confirm the operation. Refresh and try again.",
      );
      await expect(uploadRegion.getByRole("alert")).toContainText(/Reference: [0-9a-f-]{36}/i);
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

      await expect.poll(async () => {
        const result = await service.from("document_versions").select("processing_status,upload_state")
          .eq("id", pendingVersion?.id ?? "").single();
        if (result.error) return "missing";
        return result.data.upload_state === "confirmed" ? result.data.processing_status : "unconfirmed";
      }, { timeout: 60_000 }).toMatch(/^(uploaded|processing|ready|processing_failed)$/);
      await expect(row.getByText(/^(Queued|Uploaded — processing pending|Processing|Ready|Processing failed)$/))
        .toBeVisible();
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
    test.setTimeout(240_000);
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
      // Only the boundary/status enter artifacts; provider response bodies stay private.
      failedRequests.push(`${boundary}:${response.status()}`);
    });

    try {
      await page.goto("/repository");
      const fileInput = page.getByLabel("Choose PDF, DOCX, or Markdown files");
      await fileInput.setInputFiles(batchNames.map((name) => ({
        name: `${name}.md`,
        mimeType: "text/markdown",
        buffer: markdownSections(32),
      })));
      await expect(page.getByLabel("Document name")).toHaveCount(10);
      for (const [index, name] of batchNames.entries()) {
        await page.getByLabel("Document name").nth(index).fill(name);
        await page.getByRole("region", { name: "Upload documents" }).getByLabel("Category").nth(index).selectOption("SOP");
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
        .toHaveLength(10);
      expect(actualBatchStatuses.every((status) =>
        [UPLOADED_LABEL, "Processing", "Ready", "Processing failed"].includes(status),
      )).toBe(true);

      const maximumSizeBytes = Buffer.alloc(MAX_FILE_SIZE_BYTES, 0x61);
      await fileInput.setInputFiles({
        name: `${maxFileName}.md`,
        mimeType: "text/markdown",
        buffer: maximumSizeBytes,
      });
      await expect(page.getByLabel("Document name")).toHaveCount(1);
      await page.getByLabel("Document name").fill(maxFileName);
      await page.getByRole("region", { name: "Upload documents" }).getByLabel("Category").selectOption("SOP");
      const maximumSizeUpload = page.getByRole("button", { name: "Upload files" });
      await expect(maximumSizeUpload).toBeEnabled();
      await maximumSizeUpload.click();
      await expect.poll(async () => {
        const statuses = await page.getByRole("status").allTextContents();
        return statuses.some((status) => [UPLOADED_LABEL, "Processing", "Ready", "Processing failed"].includes(status));
      }, { timeout: 60_000 }).toBe(true);

      const service = serviceClient();
      const documents = await service.from("documents").select("id,name,active_version_id")
        .in("name", allNames);
      expect(documents.error).toBeNull();
      if (documents.error || documents.data.length !== 11) {
        throw new Error("The ten-file batch and 10 MiB upload were not all confirmed.");
      }
      const versions = await service.from("document_versions")
        .select("id,document_id,processing_status,version_status,upload_state,storage_path,expected_sha256")
        .in("document_id", documents.data.map((document) => document.id));
      expect(versions.error).toBeNull();
      if (versions.error || versions.data.length !== 11) {
        throw new Error("The confirmed uploads did not each produce exactly one version.");
      }

      await expect.poll(async () => {
        const current = await service.from("document_versions")
          .select("processing_status")
          .in("id", versions.data.map((version) => version.id));
        if (current.error) throw new Error("Could not poll local batch processing status.");
        return current.data.length === 11 && current.data.every((version) =>
          version.processing_status === "ready" || version.processing_status === "processing_failed",
        );
      }, { timeout: 120_000, intervals: [500, 1000, 2000] }).toBe(true);

      const settledVersions = await service.from("document_versions")
        .select("id,document_id,processing_status,version_status,upload_state,storage_path,expected_sha256")
        .in("id", versions.data.map((version) => version.id));
      expect(settledVersions.error).toBeNull();
      if (settledVersions.error || settledVersions.data.length !== 11) {
        throw new Error("Could not verify all terminal local processing versions.");
      }
      const versionsByDocument = new Map(settledVersions.data.map((version) => [version.document_id, version]));
      const settledDocuments = await service.from("documents").select("id,name,active_version_id")
        .in("name", allNames);
      expect(settledDocuments.error).toBeNull();
      if (settledDocuments.error || settledDocuments.data.length !== 11) {
        throw new Error("Could not verify all settled upload documents.");
      }
      const documentsByName = new Map(settledDocuments.data.map((document) => [document.name, document]));

      for (const name of batchNames) {
        const document = documentsByName.get(name);
        const version = document ? versionsByDocument.get(document.id) : undefined;
        expect(version).toMatchObject({ processing_status: "ready", version_status: "active", upload_state: "confirmed" });
        expect(document?.active_version_id).toBe(version?.id);
        if (!version) throw new Error("A batch upload is missing its persisted version.");

        const chunks = await service.from("document_chunks").select("chunk_index,embedding")
          .eq("version_id", version.id).order("chunk_index", { ascending: true });
        expect(chunks.error).toBeNull();
        if (chunks.error) throw new Error("Could not verify a batch upload embedding.");
        expect(chunks.data).toHaveLength(32);
        expect(chunks.data[0]?.chunk_index).toBe(0);
        if (!chunks.data[0]) throw new Error("A ready batch upload has no persisted chunk.");
        const vector = JSON.parse(chunks.data[0].embedding) as unknown;
        expect(Array.isArray(vector) && vector.length === 384 && vector.every(Number.isFinite)).toBe(true);

        const original = await service.storage.from("documents").download(version.storage_path);
        expect(original.error).toBeNull();
        if (!original.data) throw new Error("A batch original could not be opened from local Storage.");
        const expectedHash = createHash("sha256").update(markdownSections(32)).digest("hex");
        const actualHash = createHash("sha256").update(new Uint8Array(await original.data.arrayBuffer())).digest("hex");
        expect(version.expected_sha256).toBe(expectedHash);
        expect(actualHash).toBe(expectedHash);
      }

      const maxDocument = documentsByName.get(maxFileName);
      const maximumVersion = maxDocument ? versionsByDocument.get(maxDocument.id) : undefined;
      expect(maximumVersion).toMatchObject({
        processing_status: "processing_failed",
        version_status: null,
        upload_state: "confirmed",
      });
      expect(maxDocument?.active_version_id).toBeNull();
      if (!maximumVersion) throw new Error("The 10 MiB upload has no confirmed canonical version.");

      const maximumChunks = await service.from("document_chunks").select("id", { count: "exact", head: true })
        .eq("version_id", maximumVersion.id);
      expect(maximumChunks.error).toBeNull();
      expect(maximumChunks.count).toBe(0);

      const downloaded = await service.storage.from("documents").download(maximumVersion.storage_path);
      expect(downloaded.error).toBeNull();
      if (!downloaded.data) throw new Error("The 10 MiB canonical original could not be opened.");
      const actualHash = createHash("sha256")
        .update(new Uint8Array(await downloaded.data.arrayBuffer()))
        .digest("hex");
      const expectedHash = createHash("sha256").update(maximumSizeBytes).digest("hex");
      expect(actualHash).toBe(expectedHash);
      expect(maximumVersion.expected_sha256).toBe(expectedHash);

      expect(settledDocuments.data.every((document) => {
        const version = versionsByDocument.get(document.id);
        return version?.processing_status === "ready"
          ? document.active_version_id === version.id
          : document.active_version_id === null;
      })).toBe(true);

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
