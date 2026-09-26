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

export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code:
          | "UNAUTHENTICATED"
          | "FORBIDDEN"
          | "INVALID_INPUT"
          | "NOT_FOUND"
          | "CONFLICT"
          | "PROCESSING_FAILED"
          | "INTERNAL_ERROR";
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

export interface UploadedVersion {
  documentId: string;
  versionId: string;
  processingStatus: "uploaded";
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
  /** `files`: repeated File fields; `metadata`: JSON UploadMetadata[] in file order.
   * Validate 1..10 files, <=10 MiB each, with Zod + server-side file validation.
   * Per-file outcomes make partial batch success explicit; no false batch atomicity.
   */
  uploadDocuments(formData: FormData): Promise<ActionResult<ActionResult<UploadedVersion>[]>>;
  /** Reauthorize server-side; enqueue once without changing document/version IDs. */
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
