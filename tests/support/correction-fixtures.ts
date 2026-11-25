import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { createAnalysisFixture, type AnalysisFixture } from "./analysis-fixtures";
import { localSupabaseTarget } from "./local-supabase-target";
import { openLocalSqlSession, type LocalSqlSession } from "./local-sql-session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXTURE_TEXT = "# Synthetic correction candidate\n\nA valid local correction fixture.\n";

type CorrectionFixtureState = "candidate_processing" | "candidate_failed";

interface CorrectionFixtureOptions {
  state?: CorrectionFixtureState;
  content?: string;
}

export interface CorrectionFixture {
  workspaceId: string;
  documentId: string;
  activeVersionId: string;
  candidateVersionId: string;
  candidateId: string;
  roundId: string;
  submissionId: string;
  storagePath: string;
  adminId: string;
  memberId: string;
  service: SupabaseClient<Database>;
  sql: LocalSqlSession;
  readJobState(): Promise<{ operationId: string | null; status: string; attemptCount: number }>;
  expireLease(): Promise<void>;
  readFlowState(): Promise<{
    versionStatus: string | null;
    processingStatus: string;
    candidateStatus: string;
    roundStatus: string;
    activeVersionId: string | null;
    versionCount: number;
  }>;
  readCreditSnapshot(): Promise<{ ledgerCount: number; ledgerSum: number; analysisCount: number }>;
  dispose(): Promise<void>;
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("The local correction fixture received an invalid identifier.");
  return `'${value}'::uuid`;
}

function expandPsqlIncludes(fileName: string, visited = new Set<string>()): string {
  const fixtureRoot = resolve(process.cwd(), "supabase/tests/database");
  const filePath = resolve(fixtureRoot, fileName);
  if (!filePath.startsWith(`${fixtureRoot}${sep}`) || visited.has(filePath)) {
    throw new Error("The local correction SQL fixture include is outside its approved directory.");
  }
  visited.add(filePath);
  const content = readFileSync(filePath, "utf8");
  return content.replace(/^\\ir ([A-Za-z0-9_.-]+)\r?$/gm, (_match, includeName: string) =>
    expandPsqlIncludes(includeName, visited));
}

function serviceClient() {
  const target = localSupabaseTarget();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Local correction service test configuration is missing.");
  return createClient<Database>(target.apiUrl, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function cleanupReviewRows(sql: LocalSqlSession, workspaceId: string) {
  await sql.query("begin;");
  try {
    await sql.query("set local session_replication_role = replica;");
    await sql.query(
      `update public.correction_rounds set active_candidate_id = null
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from public.correction_candidate_decisions
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from public.correction_candidate_items
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from public.correction_candidates
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from public.correction_submission_items
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from public.correction_round_items
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from public.correction_submissions
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from public.correction_rounds
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query(
      `delete from private.ingestion_jobs
       where workspace_id = ${requireUuid(workspaceId)};`,
    );
    await sql.query("commit;");
  } catch (error) {
    await sql.query("rollback;").catch(() => undefined);
    throw error;
  }
}

export async function createCorrectionFixture(
  input: CorrectionFixtureOptions = {},
): Promise<CorrectionFixture> {
  const state = input.state ?? "candidate_processing";
  if (state !== "candidate_processing" && state !== "candidate_failed") {
    throw new Error("Unsupported local correction fixture state.");
  }

  let analysis: AnalysisFixture | undefined;
  let sql: LocalSqlSession | undefined;
  let service: SupabaseClient<Database> | undefined;
  let workspaceId: string | undefined;
  let documentId: string | undefined;
  let activeVersionId: string | undefined;
  let candidateVersionId: string | undefined;
  let candidateId: string | undefined;
  let roundId: string | undefined;
  let submissionId: string | undefined;
  let storagePath: string | undefined;
  let disposed = false;
  const bytes = Buffer.from(input.content ?? FIXTURE_TEXT, "utf8");

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    let storageError: unknown = null;
    if (storagePath && service) {
      const removal = await service.storage.from("documents").remove([storagePath]);
      storageError = removal.error;
    }
    try {
      if (sql && workspaceId) await cleanupReviewRows(sql, workspaceId);
    } finally {
      if (sql) await sql.close().catch(() => undefined);
      if (analysis) await analysis.dispose();
    }
    if (storageError) throw new Error("Local correction storage cleanup failed.");
  };

  try {
    analysis = await createAnalysisFixture({ versionCount: 1 });
    workspaceId = analysis.workspaceId;
    documentId = analysis.versions[0].documentId;
    activeVersionId = analysis.versions[0].versionId;
    service = serviceClient();
    sql = await openLocalSqlSession(
      `kdm_correction_worker_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      { queryTimeoutMs: 15_000 },
    );
    await sql.query(expandPsqlIncludes("review-fixtures.psql"));

    await sql.query(
      `update public.findings
       set status = 'confirmed', assignee_id = ${requireUuid(analysis.memberId)}
       where id = ${requireUuid(analysis.findingId)}
         and workspace_id = ${requireUuid(workspaceId)}
         and status = 'pending_review';`,
    );

    roundId = (await sql.query(
      `select pg_temp.create_review_round_for_document(
        ${requireUuid(workspaceId)}, ${requireUuid(documentId)}, ${requireUuid(analysis.adminId)},
        'assigned_findings', array[${requireUuid(analysis.findingId)}]::uuid[]
      )::text;`,
    )).trim();
    if (!UUID_PATTERN.test(roundId)) throw new Error("The local correction round was not created.");

    const itemId = (await sql.query(
      `select id::text from public.correction_round_items
       where round_id = ${requireUuid(roundId)}
         and finding_id = ${requireUuid(analysis.findingId)};`,
    )).trim();
    if (!UUID_PATTERN.test(itemId)) throw new Error("The local correction round item was not created.");

    submissionId = (await sql.query(
      `select pg_temp.create_review_submission(
        ${requireUuid(roundId)}, ${requireUuid(analysis.memberId)}, array[${requireUuid(itemId)}]::uuid[]
      )::text;`,
    )).trim();
    if (!UUID_PATTERN.test(submissionId)) throw new Error("The local correction submission was not created.");

    candidateId = (await sql.query(
      `select pg_temp.select_direct_review_candidate(
        ${requireUuid(roundId)}, ${requireUuid(analysis.adminId)}, ${requireUuid(submissionId)}
      )::text;`,
    )).trim();
    if (!UUID_PATTERN.test(candidateId)) throw new Error("The local correction candidate was not created.");

    const candidate = await sql.query(
      `select version_id::text || '|' || status::text
       from public.correction_candidates where id = ${requireUuid(candidateId)};`,
    );
    const [resolvedVersionId, candidateStatus] = candidate.trim().split("|");
    if (!resolvedVersionId || !UUID_PATTERN.test(resolvedVersionId) || candidateStatus !== "selected") {
      throw new Error("The local correction candidate is not selected.");
    }
    candidateVersionId = resolvedVersionId;

    storagePath = (await sql.query(
      `select storage_path from public.document_versions where id = ${requireUuid(candidateVersionId)};`,
    )).trim();
    if (!storagePath.startsWith(`${workspaceId}/${documentId}/${candidateVersionId}/original.`)) {
      throw new Error("The local correction candidate storage path is invalid.");
    }

    const upload = await service.storage.from("documents").upload(storagePath, bytes, {
      contentType: "text/markdown",
      upsert: false,
    });
    if (upload.error) throw new Error("The local correction original could not be uploaded.");

    if (state === "candidate_failed") {
      await sql.query(`select pg_temp.fail_review_candidate(${requireUuid(candidateId)});`);
    }

    const fixture: CorrectionFixture = {
      workspaceId,
      documentId,
      activeVersionId,
      candidateVersionId,
      candidateId,
      roundId,
      submissionId,
      storagePath,
      adminId: analysis.adminId,
      memberId: analysis.memberId,
      service,
      sql,
      async readJobState() {
        const values = (await sql!.query(
          `select coalesce(operation_id::text, 'NONE') || '|' || status::text || '|' || attempt_count::text
           from private.ingestion_jobs where version_id = ${requireUuid(candidateVersionId!)};`,
        )).trim().split("|");
        if (values.length !== 3 || !/^\d+$/.test(values[2])) {
          throw new Error("The local correction job state is invalid.");
        }
        return {
          operationId: values[0] === "NONE" ? null : values[0],
          status: values[1],
          attemptCount: Number(values[2]),
        };
      },
      async expireLease() {
        await sql!.query(
          `update private.ingestion_jobs
           set lease_expires_at = clock_timestamp() - interval '1 second'
           where version_id = ${requireUuid(candidateVersionId!)};
           update public.document_versions
           set processing_lease_expires_at = clock_timestamp() - interval '1 second'
           where id = ${requireUuid(candidateVersionId!)};`,
        );
      },
      async readFlowState() {
        const version = await service!.from("document_versions")
          .select("processing_status,version_status").eq("id", candidateVersionId!).single();
        if (version.error || !version.data) throw new Error("The local correction version state is unreadable.");
        const document = await service!.from("documents")
          .select("active_version_id").eq("id", documentId!).single();
        if (document.error) throw new Error("The local correction document state is unreadable.");
        const reviewValues = (await sql!.query(
          `select c.status::text || '|' || r.status::text
           from public.correction_candidates c
           join public.correction_rounds r on r.id = c.round_id
           where c.id = ${requireUuid(candidateId!)}
             and r.id = ${requireUuid(roundId!)};`,
        )).trim().split("|");
        if (reviewValues.length !== 2) throw new Error("The local correction review state is unreadable.");
        const versions = await service!.from("document_versions")
          .select("id", { count: "exact", head: true }).eq("document_id", documentId!);
        if (versions.error) throw new Error("The local correction version count is unreadable.");
        return {
          processingStatus: version.data.processing_status,
          versionStatus: version.data.version_status,
          candidateStatus: reviewValues[0],
          roundStatus: reviewValues[1],
          activeVersionId: document.data?.active_version_id ?? null,
          versionCount: versions.count ?? 0,
        };
      },
      async readCreditSnapshot() {
        const values = (await sql!.query(
          `select count(*)::text || '|' || coalesce(sum(amount), 0)::text || '|' ||
             (select count(*)::text from public.analyses where workspace_id = ${requireUuid(workspaceId!)})
           from public.credit_ledger where workspace_id = ${requireUuid(workspaceId!)};`,
        )).trim().split("|");
        const parsed = values.map(Number);
        if (values.length !== 3 || parsed.some((value) => !Number.isFinite(value))) {
          throw new Error("The local correction credit snapshot is invalid.");
        }
        return {
          ledgerCount: parsed[0],
          ledgerSum: parsed[1],
          analysisCount: parsed[2],
        };
      },
      dispose,
    };
    return fixture;
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
}
