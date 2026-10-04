export type IdentityErrorCode =
  | "UNAUTHENTICATED"
  | "WORKSPACE_REQUIRED"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

const messages: Record<IdentityErrorCode, string> = {
  UNAUTHENTICATED: "Authentication is required.",
  WORKSPACE_REQUIRED: "Workspace setup is required.",
  FORBIDDEN: "You don't have permission to access documents.",
  INTERNAL_ERROR: "Unable to verify the current identity.",
};

/** A controlled identity failure that never retains a provider or database error. */
export class IdentityError extends Error {
  constructor(readonly code: IdentityErrorCode) {
    super(messages[code]);
    this.name = "IdentityError";
  }
}
