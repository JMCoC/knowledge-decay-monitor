import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "./fixtures";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { cleanupLocalUser, getLocalUploadMode, localTestUserIdByEmail, setLocalUploadMode } from "../support/local-supabase";
import { registerThroughUi } from "../support/auth-ui";
import { markdownSections } from "../support/processing-inputs";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const ADMIN_NAME = "Synthetic Vertical Admin";
const DOCX = readFileSync(resolve("tests/fixtures/processing/docx/original.docx"));
const PDF = readFileSync(resolve("tests/fixtures/processing/pdf-text/original.pdf"));
const EMPTY_PDF = readFileSync(resolve("tests/fixtures/processing/pdf-empty/original-empty.pdf"));

type FlowCase = {
  label: string;
  documentName: string;
  fileName: string;
  extension: "md" | "pdf" | "docx";
  mimeType: string;
  bytes: Buffer;
  expectedStatus: "ready" | "processing_failed";
  expectedChunks: number;
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

async function createWorkspaceThroughUi(page: Page, email: string, password: string, workspaceName: string) {
  await registerThroughUi(page, email, password);
  await expect(page.getByLabel("Your name")).toBeVisible();
  await page.getByLabel("Your name").fill(ADMIN_NAME);
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("heading", { name: "Your knowledge, in one place." })).toBeVisible();

  const profile = await serviceClient().from("profiles")
    .select("id,workspace_id,role,full_name")
    .eq("email", email)
    .single();
  if (profile.error || !profile.data?.workspace_id) {
    throw new Error("The UI-created local Admin Profile could not be verified.");
  }
  return {
    userId: profile.data.id,
    workspaceId: profile.data.workspace_id,
    role: profile.data.role,
    fullName: profile.data.full_name,
  };
}

async function uploadThroughUi(page: Page, input: FlowCase, ownerId: string) {
  await page.goto("/repository");
  const panel = page.getByRole("region", { name: "Upload documents" });
  await panel.getByLabel("Choose PDF, DOCX, or Markdown files").setInputFiles({
    name: input.fileName,
    mimeType: input.mimeType,
    buffer: input.bytes,
  });
  await page.getByLabel("Document name").fill(input.documentName);
  await panel.getByLabel("Category").selectOption("Policy");
  await panel.getByLabel("Owner").selectOption(ownerId);
  await panel.getByRole("button", { name: "Upload files" }).click();
  await expect(panel.getByRole("status")).toHaveText("Uploaded — processing pending", { timeout: 45_000 });
}

async function findDocument(workspaceId: string, name: string) {
  const result = await serviceClient().from("documents")
    .select("id,name,workspace_id,category,owner_id,active_version_id")
    .eq("workspace_id", workspaceId)
    .eq("name", name)
    .single();
  if (result.error || !result.data) throw new Error("The uploaded local document row could not be verified.");
  return result.data;
}

async function waitForTerminalVersion(versionId: string) {
  const service = serviceClient();
  const deadline = Date.now() + 65_000;
  let latest: {
    id: string;
    processing_status: string | null;
    version_status: string | null;
    storage_path: string;
    expected_sha256: string | null;
    upload_state: string | null;
  } | null = null;

  while (Date.now() < deadline) {
    const result = await service.from("document_versions")
      .select("id,processing_status,version_status,storage_path,expected_sha256,upload_state")
      .eq("id", versionId)
      .single();
    if (result.error || !result.data) throw new Error("The processing version query failed.");
    const current = result.data;
    latest = current;
    if (current.processing_status === "ready" || current.processing_status === "processing_failed") return current;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return latest;
}

async function verifyOriginalFromRepositoryUi(
  page: Page,
  context: BrowserContext,
  documentName: string,
  issues: string[],
  label: string,
) {
  let popup: Page | null = null;
  try {
    await page.goto(`/repository?name=${encodeURIComponent(documentName)}`);
    const row = page.getByRole("row").filter({ hasText: documentName });
    const openButton = row.getByRole("button", { name: `Open file ${documentName}` });
    await expect(openButton).toBeVisible({ timeout: 15_000 });

    const signedRequest = context.waitForEvent("request", {
      predicate: (request) => {
        const url = new URL(request.url());
        return request.method() === "GET"
          && url.origin === LOCAL_API_URL
          && url.pathname.startsWith("/storage/v1/object/sign/documents/");
      },
      timeout: 15_000,
    });
    const popupEvent = page.waitForEvent("popup", { timeout: 15_000 });
    await openButton.click();
    [popup] = [await popupEvent];
    const request = await signedRequest;
    const response = await request.response();
    if (response?.status() !== 200) issues.push(`${label}: UI could not open the confirmed original.`);
  } catch {
    issues.push(`${label}: UI could not open the confirmed original.`);
  } finally {
    if (popup && !popup.isClosed()) await popup.close().catch(() => undefined);
  }
}

async function cleanupDocuments(names: string[], workspaceId?: string) {
  if (names.length === 0) return;
  const service = serviceClient();
  let query = service.from("documents").select("id").in("name", names);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const documents = await query;
  if (documents.error) throw new Error("Could not inspect the synthetic full-flow documents for cleanup.");
  const documentIds = documents.data.map((document) => document.id);
  if (documentIds.length === 0) return;

  const versions = await service.from("document_versions").select("id,storage_path").in("document_id", documentIds);
  if (versions.error) throw new Error("Could not inspect the synthetic full-flow versions for cleanup.");
  const versionIds = versions.data.map((version) => version.id);
  const attempts = versionIds.length > 0
    ? await service.from("document_upload_attempts").select("storage_path").in("version_id", versionIds)
    : { data: [], error: null };
  if (attempts.error) throw new Error("Could not inspect the synthetic full-flow upload attempts for cleanup.");

  const paths = [
    ...versions.data.map((version) => version.storage_path),
    ...attempts.data.map((attempt) => attempt.storage_path),
  ];
  if (paths.length > 0) {
    const removedStorage = await service.storage.from("documents").remove(paths);
    if (removedStorage.error) throw new Error("Could not remove the synthetic full-flow Storage objects.");
  }
  const removedRows = await service.from("documents").delete().in("id", documentIds);
  if (removedRows.error) throw new Error("Could not remove the synthetic full-flow document rows.");
}

test.describe("First vertical processing flow", () => {
  let previousUploadMode: "paused" | "active";

  test.beforeAll(() => {
    previousUploadMode = getLocalUploadMode();
    if (previousUploadMode !== "active") setLocalUploadMode("active");
  });

  test.afterAll(() => {
    if (getLocalUploadMode() !== previousUploadMode) setLocalUploadMode(previousUploadMode);
  });

  test("uploads, processes, persists, and reopens every promised document shape", async ({ page, context }) => {
    test.setTimeout(600_000);
    const suffix = randomUUID();
    const email = `kdm-${suffix}@example.test`;
    const password = `Kdm-${randomUUID()}`;
    const workspaceName = `kdm-${suffix}`;
    const prefix = `S1-08 flow ${suffix}`;
    const cases: FlowCase[] = [
      {
        label: "markdown",
        documentName: `${prefix} markdown`,
        fileName: "runbook.md",
        extension: "md",
        mimeType: "text/markdown",
        bytes: Buffer.from("# Synthetic flow\n\nA complete Markdown processing acceptance document.\n", "utf8"),
        expectedStatus: "ready",
        expectedChunks: 1,
      },
      {
        label: "docx",
        documentName: `${prefix} docx`,
        fileName: "original.docx",
        extension: "docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: DOCX,
        expectedStatus: "ready",
        expectedChunks: 1,
      },
      {
        label: "pdf",
        documentName: `${prefix} pdf`,
        fileName: "original.pdf",
        extension: "pdf",
        mimeType: "application/pdf",
        bytes: PDF,
        expectedStatus: "ready",
        expectedChunks: 1,
      },
      {
        label: "nine chunks",
        documentName: `${prefix} nine chunks`,
        fileName: "nine-sections.md",
        extension: "md",
        mimeType: "text/markdown",
        bytes: markdownSections(9),
        expectedStatus: "ready",
        expectedChunks: 9,
      },
      {
        label: "thirty-two chunks",
        documentName: `${prefix} thirty-two chunks`,
        fileName: "thirty-two-sections.md",
        extension: "md",
        mimeType: "text/markdown",
        bytes: markdownSections(32),
        expectedStatus: "ready",
        expectedChunks: 32,
      },
      {
        label: "empty PDF",
        documentName: `${prefix} empty pdf`,
        fileName: "empty.pdf",
        extension: "pdf",
        mimeType: "application/pdf",
        bytes: EMPTY_PDF,
        expectedStatus: "processing_failed",
        expectedChunks: 0,
      },
      {
        label: "chunk cap",
        documentName: `${prefix} over chunk cap`,
        fileName: "five-hundred-one-sections.md",
        extension: "md",
        mimeType: "text/markdown",
        bytes: markdownSections(501),
        expectedStatus: "processing_failed",
        expectedChunks: 0,
      },
    ];
    const issues: string[] = [];
    let workspaceId: string | undefined;

    try {
      const profile = await createWorkspaceThroughUi(page, email, password, workspaceName);
      workspaceId = profile.workspaceId;
      if (profile.role !== "Admin" || profile.fullName !== ADMIN_NAME) {
        issues.push("UI registration did not create the expected Admin Profile.");
      }

      for (const input of cases) {
        try {
          await uploadThroughUi(page, input, profile.userId);
          const document = await findDocument(profile.workspaceId, input.documentName);
          if (document.category !== "Policy" || document.owner_id !== profile.userId) {
            issues.push(`${input.label}: category or owner metadata did not persist.`);
          }

          const versionResult = await serviceClient().from("document_versions")
            .select("id")
            .eq("document_id", document.id)
            .single();
          if (versionResult.error || !versionResult.data) {
            issues.push(`${input.label}: uploaded version could not be found.`);
            continue;
          }

          const version = await waitForTerminalVersion(versionResult.data.id);
          if (!version) {
            issues.push(`${input.label}: processing version disappeared.`);
            continue;
          }
          if (version.processing_status !== input.expectedStatus) {
            issues.push(`${input.label}: expected ${input.expectedStatus}, got ${version.processing_status ?? "null"}.`);
          }
          if (version.upload_state !== "confirmed") {
            issues.push(`${input.label}: confirmed upload state did not persist.`);
          }

          const storedDocument = await findDocument(profile.workspaceId, input.documentName);
          const expectedPointer = input.expectedStatus === "ready" && version.processing_status === "ready"
            ? version.id
            : null;
          if (storedDocument.active_version_id !== expectedPointer) {
            issues.push(`${input.label}: active-version pointer does not match processing status.`);
          }
          if (version.version_status !== (expectedPointer ? "active" : null)) {
            issues.push(`${input.label}: version status does not match the active pointer.`);
          }

          const downloaded = await serviceClient().storage.from("documents").download(version.storage_path);
          if (downloaded.error || !downloaded.data) {
            issues.push(`${input.label}: canonical original could not be downloaded.`);
          } else {
            const actualBytes = new Uint8Array(await downloaded.data.arrayBuffer());
            const expectedHash = createHash("sha256").update(input.bytes).digest("hex");
            const storedHash = createHash("sha256").update(actualBytes).digest("hex");
            if (expectedHash !== storedHash || version.expected_sha256 !== expectedHash) {
              issues.push(`${input.label}: original hash does not match the confirmed upload.`);
            }
          }

          const chunksResult = await serviceClient().from("document_chunks")
            .select("chunk_index,embedding")
            .eq("version_id", version.id)
            .order("chunk_index", { ascending: true });
          if (chunksResult.error) {
            issues.push(`${input.label}: persisted chunks could not be queried.`);
          } else if (input.expectedStatus === "ready") {
            const chunks = chunksResult.data;
            if (chunks.length !== input.expectedChunks) {
              issues.push(`${input.label}: expected ${input.expectedChunks} chunks, got ${chunks.length}.`);
            }
            if (chunks.some((chunk, index) => chunk.chunk_index !== index)) {
              issues.push(`${input.label}: persisted chunk indices are not contiguous.`);
            }
            for (const chunk of chunks) {
              try {
                const vector = JSON.parse(chunk.embedding) as unknown;
                if (!Array.isArray(vector) || vector.length !== 384 || !vector.every(Number.isFinite)) {
                  issues.push(`${input.label}: a persisted embedding is not a finite 384-dimension vector.`);
                }
              } catch {
                issues.push(`${input.label}: a persisted embedding is not valid vector data.`);
              }
            }
          } else if (chunksResult.data.length !== 0) {
            issues.push(`${input.label}: rejected content left persisted chunks.`);
          }

          await verifyOriginalFromRepositoryUi(page, context, input.documentName, issues, input.label);
        } catch {
          issues.push(`${input.label}: the end-to-end case did not complete.`);
        }
      }
    } finally {
      try {
        await cleanupDocuments(cases.map((input) => input.documentName), workspaceId);
      } finally {
        const userId = localTestUserIdByEmail(email);
        if (userId) await cleanupLocalUser(userId);
      }
    }

    expect(issues).toEqual([]);
  });
});
