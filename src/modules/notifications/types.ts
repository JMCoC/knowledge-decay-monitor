export type NotificationFailureCode = "DELIVERY_FAILED" | "RECIPIENT_UNAVAILABLE" | "INTERNAL_ERROR";

export type NotificationResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: NotificationFailureCode | "LEASE_LOST" };

export type NotificationKind = "analysis_completed" | "analysis_failed";

export type NotificationLease = {
  eventId: string;
  operationId: string;
  attemptCount: number;
  leaseExpiresAt: string;
};

export type NotificationContext = {
  eventId: string;
  analysisId: string;
  workspaceId: string;
  recipientId: string;
  recipientEmail: string;
  type: NotificationKind;
  finishedAt: string;
};

export type NotificationBody = {
  from: string;
  to: [string];
  subject: string;
  html: string;
  text: string;
};

export type PreparedNotification = {
  body: NotificationBody;
  requestJson: string;
  idempotencyKey: string;
  firstSubmissionAt: string;
};

export type SendNotificationResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; code: "DELIVERY_FAILED"; retryAfterSeconds?: number };

export type NotificationAlertLease = {
  eventId: string;
  operationId: string;
  code: NotificationFailureCode;
};

export type NotificationCandidate = {
  eventId: string;
  recoverExpired: boolean;
};

export interface NotificationStore {
  listCandidates(limit: number): Promise<NotificationResult<NotificationCandidate[]>>;
  claim(eventId: string): Promise<NotificationResult<NotificationLease | null>>;
  context(lease: NotificationLease): Promise<NotificationResult<NotificationContext>>;
  prepare(lease: NotificationLease, body: NotificationBody): Promise<NotificationResult<PreparedNotification>>;
  sent(lease: NotificationLease, providerMessageId: string): Promise<NotificationResult<boolean>>;
  failed(
    lease: NotificationLease,
    code: NotificationFailureCode,
    retryAfterSeconds?: number,
  ): Promise<NotificationResult<"pending" | "failed" | "lost">>;
  recover(eventId: string): Promise<NotificationResult<"pending" | "failed" | "unchanged">>;
  listAlerts(limit: number): Promise<NotificationResult<string[]>>;
  claimAlert(eventId: string): Promise<NotificationResult<NotificationAlertLease | null>>;
  alertSent(alert: NotificationAlertLease): Promise<NotificationResult<boolean>>;
  alertFailed(alert: NotificationAlertLease): Promise<NotificationResult<boolean>>;
}

export type NotificationConfig = {
  enabled: boolean;
  internalToken: string;
  apiKey: string;
  from: string;
  appOrigin: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  sentryDsn: string;
  environment: "development" | "vercel-preview" | "vercel-production";
  release: string;
};

export type NotificationDispatchDeps = {
  store: NotificationStore;
  send: (prepared: PreparedNotification) => Promise<SendNotificationResult>;
  report: (alert: NotificationAlertLease) => Promise<boolean>;
  config: Pick<NotificationConfig, "from" | "appOrigin">;
  monotonicNow: () => number;
  utcNow: () => number;
};

export type NotificationDispatchSummary = {
  claimed: number;
  sent: number;
  failed: number;
  reported: number;
};

export type NotificationHandlerEnv = Record<string, string | undefined>;

export interface NotificationHandlerDeps {
  createStore(config: NotificationConfig): NotificationStore;
  createSender(config: NotificationConfig): NotificationDispatchDeps["send"];
  createReporter(config: NotificationConfig): NotificationDispatchDeps["report"];
  isDispatchEnabled(config: NotificationConfig): Promise<boolean>;
  runDispatch(deps: NotificationDispatchDeps): Promise<NotificationDispatchSummary>;
  waitUntil(work: Promise<unknown>): void;
}

export interface NotificationSentrySdk {
  captureEvent(event: Record<string, unknown>): string;
  flush(timeoutMs: number): Promise<boolean>;
  clearDeliveryStatus(eventId: string): void;
  deliveryStatus(eventId: string): number | undefined;
}

export class NotificationReadinessError extends Error {
  constructor() {
    super("Notification service is not ready.");
    this.name = "NotificationReadinessError";
  }
}
