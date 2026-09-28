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

export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: ActionErrorCode;
        /** Controlled user-facing text, never an exception or provider payload. */
        message: string;
      };
    };

export interface CreateWorkspaceInput {
  name: string;
  fullName: string;
}

export interface UploadMetadata {
  name: string;
  category: DocumentCategory;
  ownerId: string;
}

/** Declared facts about one file. The server never receives the bytes in S1-03. */
export interface UploadItemInput {
  /** name, category, ownerId. Unchanged from the Day Cero contract. */
  metadata: UploadMetadata;
  /** Only used to derive the validated extension and for diagnostics. */
  fileName: string;
  declaredMimeType: string;
  sizeBytes: number;
  /**
   * First 8 bytes of the file in base64: exactly 12 characters, 11 of data and
   * a trailing `=`. Checked in memory, never persisted. Not a security control
   * — it is a sanity check that avoids uploading 10 MiB of a mislabelled file.
   */
  signature: string;
}

export interface UploadItemResult {
  index: number;
  outcome:
    | {
        ok: true;
        documentId: string;
        versionId: string;
        /** <workspace>/<document>/<version>/original.<ext>, resolved by the server. */
        storagePath: string;
        /** Canonical MIME derived from the extension. Must be sent to Storage. */
        canonicalMimeType: string;
      }
    | { ok: false; error: { code: ActionErrorCode; message: string } };
}

export interface FinalizeItemResult {
  versionId: string;
  outcome:
    | { ok: true; processingStatus: "uploaded" | "processing" }
    | { ok: false; error: { code: ActionErrorCode; message: string } };
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
  latestVersion: Pick<
    DocumentVersion,
    "id" | "version_number" | "processing_status" | "version_status" | "analysis_status"
  > | null;
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
}

export interface WorkspaceApi {
  createWorkspace(input: CreateWorkspaceInput): Promise<ActionResult<{ workspaceId: string }>>;
}

export interface IngestionApi {
  /** 1..10 items. The batch is not atomic: each item has its own result. */
  reserveUpload(items: UploadItemInput[]): Promise<ActionResult<UploadItemResult[]>>;
  /** Reauthorizes on the server. Never accepts a bucket, path or expiry from the browser. */
  finalizeUpload(versionIds: string[]): Promise<ActionResult<FinalizeItemResult[]>>;
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
