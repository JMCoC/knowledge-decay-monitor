import type { Database } from "./database";

type Tables = Database["public"]["Tables"];
type Enums = Database["public"]["Enums"];

export type Workspace = Tables["workspaces"]["Row"];
export type Profile = Tables["profiles"]["Row"];
export type Document = Tables["documents"]["Row"];
export type DocumentVersion = Tables["document_versions"]["Row"];
export type DocumentChunk = Tables["document_chunks"]["Row"];
export type WorkspaceRole = Enums["workspace_role"];
export type DocumentCategory = Enums["document_category"];
export type ProcessingStatus = Enums["processing_status"];
export type VersionStatus = Enums["version_status"];
export type AnalysisStatus = Enums["analysis_status"];

/** Constructed on the server from a verified session and persisted Profile. */
export interface Actor {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * Named so per-item results in a batch can reuse it. S1-03 emits
 * UNAUTHENTICATED, FORBIDDEN, INVALID_INPUT, NOT_FOUND and INTERNAL_ERROR;
 * CONFLICT and PROCESSING_FAILED are reserved for later sprints.
 */
export type ActionErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PROCESSING_FAILED"
  | "INTERNAL_ERROR";

export type ActionError = {
  code: ActionErrorCode;
  /** Controlled user-facing text, never an exception or provider payload. */
  message: string;
  correlationId?: string;
};

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

export interface CreateWorkspaceInput {
  name: string;
  fullName: string;
}

export interface UploadMetadata {
  name: string;
  category: DocumentCategory;
  ownerId: string;
}

/** Browser declaration; the server independently verifies every byte before promotion. */
export interface UploadItemInput {
  metadata: UploadMetadata;
  fileName: string;
  declaredMimeType: string;
  sizeBytes: number;
  /** First min(8, sizeBytes) bytes, base64 encoded and checked in memory. */
  signature: string;
  /** Generated before a reservation and reused after a lost response. */
  idempotencyKey: string;
  /** SHA-256 of the selected bytes; server recomputes it before confirmation. */
  sha256: string;
}

export type UploadState = "pending" | "verifying" | "rejected" | "recovering" | "confirmed";

export interface UploadReference {
  sizeBytes: number;
  sha256: string;
  signature: string;
}

/** Safe public state. It does not contain hashes, paths, leases, or operation ids. */
export interface UploadSnapshot {
  versionId: string;
  uploadState: UploadState | null;
  attemptId: string | null;
  canOpen: boolean;
  canResume: boolean;
  canRecover: boolean;
}

/** A short-lived transfer target created by a server-authorized reservation. */
export interface UploadTarget {
  versionId: string;
  attemptId: string;
  storagePath: string;
  canonicalMimeType: string;
}

export interface UploadItemResult {
  index: number;
  outcome:
    | {
        ok: true;
        documentId: string;
        target: UploadTarget;
      }
    | { ok: false; error: ActionError };
}

/** Undefined means no filter; null explicitly means Unassigned/no version status. */
export interface RepositoryQuery {
  name?: string;
  category?: DocumentCategory;
  ownerId?: string | null;
  versionStatus?: VersionStatus | null;
  page?: number;
  pageSize?: number;
}

export interface RepositoryItem {
  id: string;
  name: string;
  category: DocumentCategory;
  owner: Pick<Profile, "id" | "full_name"> | null;
  activeVersionId: string | null;
  /** Latest version, not an inner join through active_version_id. */
  latestVersion:
    | {
        id: string;
        version_number: number;
        processing_status: ProcessingStatus | null;
        version_status: VersionStatus | null;
        analysis_status: AnalysisStatus | null;
        uploadState: UploadState | null;
        canOpen: boolean;
      }
    | null;
  createdAt: string;
}

export interface RepositoryPage {
  items: RepositoryItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Type contracts only. Implementations live in the owning business module. */
export interface IdentityApi {
  requireActor(): Promise<Actor>;
  requireDocumentActor(): Promise<Actor>;
}

export interface EligibleOwner {
  id: string;
  fullName: string;
}

export interface WorkspaceApi {
  createWorkspace(input: CreateWorkspaceInput): Promise<ActionResult<{ workspaceId: string }>>;
  listEligibleOwners(): Promise<ActionResult<EligibleOwner[]>>;
}

export interface IngestionApi {
  /** 1..10 items. The batch is not atomic: each item has its own result. */
  reserveUpload(items: UploadItemInput[]): Promise<ActionResult<UploadItemResult[]>>;
  getUploadState(versionId: string): Promise<ActionResult<UploadSnapshot>>;
  /** Reauthorizes the exact current version/attempt pair. */
  finalizeUpload(input: { versionId: string; attemptId: string }): Promise<ActionResult<UploadSnapshot>>;
  resumeUpload(versionId: string, reference?: UploadReference): Promise<ActionResult<UploadTarget | UploadSnapshot>>;
  recoverUpload(versionId: string): Promise<ActionResult<UploadSnapshot>>;
  /** Unchanged in S1-03. Implemented by S1-07. */
  retryProcessing(versionId: string): Promise<
    ActionResult<{ versionId: string; processingStatus: "uploaded" | "processing" }>
  >;
}

export interface RepositoryApi {
  /** Page defaults: 1 / 25; maximum pageSize: 100. Name search is non-semantic. */
  listDocuments(query: RepositoryQuery): Promise<ActionResult<RepositoryPage>>;
  /** Server resolves path + bucket. Fixed 300-second expiry; never persist the URL. */
  getOriginalUrl(versionId: string): Promise<ActionResult<{ url: string; expiresAt: string }>>;
}
