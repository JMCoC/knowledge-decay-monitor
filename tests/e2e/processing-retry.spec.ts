import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
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
      processing_status: "processing_failed",
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

    return { name, documentId, versionId, storagePath, bytes: input.bytes };
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
      await expect(page.getByText("Processing failed. Review the document and try again.", { exact: true })).toBeVisible({ timeout: 30_000 });
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
});
