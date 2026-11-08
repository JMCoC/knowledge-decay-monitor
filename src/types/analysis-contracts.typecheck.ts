import type {
  AnalysisApi,
  AnalysisEstimate,
  AnalysisJobStatus,
  AnalysisSnapshot,
  AnalysisScopeRole,
  CreditEventType,
  FindingSeverity,
  FindingSummary,
  FindingStatus,
  FindingType,
} from "./contracts";
import type { AnalysisFailureCode } from "./analysis-internal";
import type { Database } from "./database";

type Equal<Left, Right> = [Left] extends [Right]
  ? ([Right] extends [Left] ? true : false)
  : false;
type Assert<T extends true> = T;

export type AnalysisJobStatusMatchesDatabase = Assert<Equal<
  AnalysisJobStatus,
  Database["public"]["Enums"]["analysis_job_status"]
>>;
export type AnalysisScopeRoleMatchesDatabase = Assert<Equal<
  AnalysisScopeRole,
  Database["public"]["Enums"]["analysis_scope_role"]
>>;
export type FindingTypeMatchesDatabase = Assert<Equal<
  FindingType,
  Database["public"]["Enums"]["finding_type"]
>>;
export type FindingSeverityMatchesDatabase = Assert<Equal<
  FindingSeverity,
  Database["public"]["Enums"]["finding_severity"]
>>;
export type FindingStatusMatchesDatabase = Assert<Equal<
  FindingStatus,
  Database["public"]["Enums"]["finding_status"]
>>;
export type CreditEventTypeMatchesDatabase = Assert<Equal<
  CreditEventType,
  Database["public"]["Enums"]["credit_event_type"]
>>;
export type AnalysisFailureCodeMatchesDatabase = Assert<Equal<
  AnalysisFailureCode,
  Database["public"]["Enums"]["analysis_failure_code"]
>>;

const _status: AnalysisJobStatus = "queued";
const _run: AnalysisApi["runAnalysis"] = async () => ({
  ok: true,
  data: { analysisId: "synthetic-analysis", status: "queued" },
});

declare const finding: FindingSummary;
// @ts-expect-error confidence is not a public property
void finding.confidence;

declare const estimate: AnalysisEstimate;
// @ts-expect-error provider configuration is internal
void estimate.providerConfig;

declare const snapshot: AnalysisSnapshot;
// @ts-expect-error lease state is internal
void snapshot.leaseExpiresAt;

declare const api: AnalysisApi;
// @ts-expect-error Eligibility is defined by the server, not a caller-supplied status filter
void api.listEligibleDocuments({ versionStatus: "active" });
// @ts-expect-error tenant is derived from the verified identity
void api.runAnalysis({ estimateRef: "synthetic-estimate", idempotencyKey: "key", workspaceId: "foreign" });
// @ts-expect-error client cannot choose the tenant, role, or trusted cost
void api.estimateAnalysis({ sourceVersionIds: [], comparisonVersionIds: [], workspaceId: "foreign", role: "Admin", fixedCost: 1 });

void [_status, _run, estimate, snapshot];
