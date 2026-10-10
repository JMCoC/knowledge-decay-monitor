import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisJobStatus } from "../../src/types/contracts";
import type { Database } from "../../src/types/database";
import {
  assertLocalSupabaseReady,
  cleanupLocalUser,
  insertLocalProfile,
  newLocalUser,
  ownWorkspaceId,
} from "./local-supabase";
import { LocalSqlError, openLocalSqlSession, type LocalSqlSession } from "./local-sql-session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_PATTERN = /^kdm-[0-9a-f-]{36}$/i;
const EMAIL_PATTERN = /^kdm-[0-9a-f-]{36}@example\.test$/i;
const EMBEDDING = `[1,${Array.from({ length: 383 }, () => "0").join(",")}]`;
const ANALYSIS_STATUSES = new Set<AnalysisJobStatus>(["queued", "processing", "completed", "failed"]);

export interface AnalysisFixtureOptions {
  versionCount?: number;
  unscopedVersionCount?: number;
  status?: AnalysisJobStatus;
  withLedger?: boolean;
}

export interface AnalysisFixture {
  workspaceId: string;
  analysisId: string;
  findingId: string;
  evidenceId: string;
  versions: Array<{ documentId: string; versionId: string; chunkId: string }>;
  admin: SupabaseClient<Database>;
  qa: SupabaseClient<Database>;
  member: SupabaseClient<Database>;
  adminId: string;
  qaId: string;
  memberId: string;
  sql: LocalSqlSession;
  dispose(): Promise<void>;
}

export interface AnalysisFixtureCheckpoint {
  workspaceId: string;
  analysisId: string;
  adminId: string;
  workspaceName: string;
}

interface LocalUser {
  client: SupabaseClient<Database>;
  userId: string;
  email: string;
}

class InjectedAnalysisFixtureFailure extends Error {}

function sqlLiteral(value: string) {
  if (value.includes("\0")) throw new Error("Invalid local analysis fixture value.");
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid local analysis fixture identifier.");
  return `${sqlLiteral(value)}::uuid`;
}

function localSqlName(prefix: "kdm_analysis_cleanup" | "kdm_analysis_fixture") {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function validatedOptions(options: AnalysisFixtureOptions) {
  const versionCount = options.versionCount ?? 1;
  const unscopedVersionCount = options.unscopedVersionCount ?? 0;
  const status = options.status ?? "completed";
  const withLedger = options.withLedger ?? false;
  if (
    !Number.isInteger(versionCount) || versionCount < 1 || versionCount > 20
    || !Number.isInteger(unscopedVersionCount) || unscopedVersionCount < 0 || unscopedVersionCount > 2
    || !ANALYSIS_STATUSES.has(status)
    || typeof withLedger !== "boolean"
  ) {
    throw new Error("Invalid local analysis fixture options.");
  }
  return { versionCount, unscopedVersionCount, status, withLedger };
}

function analysisDataSql(input: {
  workspaceId: string;
  adminId: string;
  memberId: string;
  status: AnalysisJobStatus;
  withLedger: boolean;
  versionCount: number;
  versions: AnalysisFixture["versions"];
  analysisId: string;
  findingId: string;
  evidenceId: string;
}) {
  const workspaceId = sqlUuid(input.workspaceId);
  const adminId = sqlUuid(input.adminId);
  const memberId = sqlUuid(input.memberId);
  const analysisId = sqlUuid(input.analysisId);
  const findingId = sqlUuid(input.findingId);
  const evidenceId = sqlUuid(input.evidenceId);
  const statements = ["begin;"];
  const publicStatus = sqlLiteral(input.status);
  const errorCode = input.status === "failed" ? "'PROVIDER_UNAVAILABLE'::public.analysis_failure_code" : "null";
  const finishedAt = input.status === "completed" || input.status === "failed" ? "now()" : "null";
  statements.push(
    `insert into public.analyses(id,workspace_id,initiator_id,status,fixed_cost,reserved_credits,idempotency_key,request_fingerprint,retry_of_analysis_id,retrieval_config,pricing_version,prompt_version,output_schema_version,provider_config,provider_used,model_used,attempt_count,operation_id,lease_expires_at,started_at,finished_at,error_code) values (${analysisId},${workspaceId},${adminId},${publicStatus}::public.analysis_job_status,3,3,${sqlLiteral(randomUUID())},${sqlLiteral(randomUUID())},null,'{"topK":5}'::jsonb,'fixture-pricing-v1','fixture-prompt-v1','fixture-output-v1','{"primary":{"provider":"synthetic"}}'::jsonb,null,null,1,${sqlUuid(randomUUID())},now() + interval '1 minute',now(),${finishedAt},${errorCode});`,
  );

  for (const [index, version] of input.versions.entries()) {
    const documentId = sqlUuid(version.documentId);
    const versionId = sqlUuid(version.versionId);
    const chunkId = sqlUuid(version.chunkId);
    const documentName = sqlLiteral(`Analysis fixture ${version.documentId}`);
    const storagePath = sqlLiteral(`${input.workspaceId}/${version.documentId}/${version.versionId}/original.md`);
    statements.push(
      `insert into public.documents(id,workspace_id,name,category,owner_id) values (${documentId},${workspaceId},${documentName},'SOP',${memberId});`,
      `insert into public.document_versions(id,workspace_id,document_id,version_number,storage_path,processing_status,version_status) values (${versionId},${workspaceId},${documentId},1,${storagePath},'ready','active');`,
      `update public.documents set active_version_id = ${versionId} where id = ${documentId} and workspace_id = ${workspaceId};`,
      `insert into public.document_chunks(id,workspace_id,version_id,chunk_index,text_content,page_number,section_heading,embedding) values (${chunkId},${workspaceId},${versionId},0,'Synthetic analysis fixture chunk',1,'Fixture',${sqlLiteral(EMBEDDING)}::extensions.vector(384));`,
    );
    if (index < input.versionCount) {
      const scopeRole = index === 0 ? "source" : "comparison";
      statements.push(
        `insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role) values (${analysisId},${workspaceId},${documentId},${versionId},'${scopeRole}');`,
      );
    }
  }

  statements.push(
    `insert into public.findings(id,workspace_id,analysis_id,type,severity_original,severity_current,confidence,explanation,status,assignee_id,fingerprint) values (${findingId},${workspaceId},${analysisId},'contradiction','High','High',0.42,'Synthetic analysis finding','pending_review',null,${sqlLiteral(randomUUID())});`,
    `insert into public.finding_evidence(id,workspace_id,analysis_id,finding_id,document_id,version_id,chunk_id,page_number,section,section_heading,snapshot) values (${evidenceId},${workspaceId},${analysisId},${findingId},${sqlUuid(input.versions[0].documentId)},${sqlUuid(input.versions[0].versionId)},${sqlUuid(input.versions[0].chunkId)},1,'Fixture','Synthetic section','Synthetic analysis evidence snapshot');`,
  );

  if (input.status === "completed" || input.status === "failed") {
    const notificationType = input.status === "completed" ? "analysis_completed" : "analysis_failed";
    statements.push(
      `insert into public.notification_events(workspace_id,analysis_id,type,recipient_id) values (${workspaceId},${analysisId},'${notificationType}',${adminId});`,
    );
  }
  if (input.withLedger) {
    statements.push(
      `insert into public.credit_ledger(workspace_id,event_type,amount) values (${workspaceId},'Promotional',50);`,
      `insert into public.credit_ledger(workspace_id,event_type,amount,analysis_id) values (${workspaceId},'Reserved',3,${analysisId});`,
    );
  }
  statements.push("commit;");
  return statements.join("\n");
}

async function createAnalysisFixtureInternal(
  rawOptions: AnalysisFixtureOptions = {},
  afterPersist?: (checkpoint: AnalysisFixtureCheckpoint) => void,
): Promise<AnalysisFixture> {
  const options = validatedOptions(rawOptions);
  const users: LocalUser[] = [];
  let admin: LocalUser | undefined;
  let qa: LocalUser | undefined;
  let member: LocalUser | undefined;
  let workspaceId: string | undefined;
  let workspaceName: string | undefined;
  let analysisId: string | undefined;
  let sql: LocalSqlSession | undefined;
  let transactionOpen = false;
  let persistedRowsCleaned = false;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;

    if (workspaceId && admin && workspaceName && !persistedRowsCleaned) {
      const session = sql ?? await openLocalSqlSession(localSqlName("kdm_analysis_cleanup"));
      sql = session;
      try {
        let ownership: string;
        try {
          ownership = await session.query(`
            select count(*)::text
            from public.workspaces w
            join public.profiles p on p.workspace_id = w.id
            where w.id = ${sqlUuid(workspaceId)}
              and w.name = ${sqlLiteral(workspaceName)}
              and p.id = ${sqlUuid(admin.userId)}
              and p.workspace_id = w.id
              and p.email = ${sqlLiteral(admin.email)};
          `);
        } catch (error) {
          const sqlState = error instanceof LocalSqlError ? ` (SQLSTATE ${error.sqlState ?? "unavailable"})` : "";
          throw new Error(`Local analysis ownership check failed${sqlState}.`);
        }
        if (ownership.trim() !== "1") {
          throw new Error("Refusing to remove analysis rows without the exact synthetic workspace owner.");
        }
        try {
          await session.query("begin;");
        } catch (error) {
          const sqlState = error instanceof LocalSqlError ? ` (SQLSTATE ${error.sqlState ?? "unavailable"})` : "";
          throw new Error(`Local analysis cleanup begin failed${sqlState}.`);
        }
        const cleanupStatements = [
          ["notification outbox", `delete from public.notification_events where workspace_id = ${sqlUuid(workspaceId)};`],
          ["finding evidence", `delete from public.finding_evidence where workspace_id = ${sqlUuid(workspaceId)};`],
          ["findings", `delete from public.findings where workspace_id = ${sqlUuid(workspaceId)};`],
          ["credit ledger", `delete from public.credit_ledger where workspace_id = ${sqlUuid(workspaceId)};`],
          ["analysis scope", `delete from public.analysis_documents where workspace_id = ${sqlUuid(workspaceId)};`],
          ["analysis runs", `delete from public.analyses where workspace_id = ${sqlUuid(workspaceId)};`],
        ] as const;
        for (const [label, statement] of cleanupStatements) {
          try {
            await session.query(statement);
          } catch (error) {
            const sqlState = error instanceof LocalSqlError ? ` (SQLSTATE ${error.sqlState ?? "unavailable"})` : "";
            throw new Error(`Local analysis ${label} cleanup failed${sqlState}.`);
          }
        }
        try {
          await session.query("commit;");
        } catch (error) {
          const sqlState = error instanceof LocalSqlError ? ` (SQLSTATE ${error.sqlState ?? "unavailable"})` : "";
          throw new Error(`Local analysis cleanup commit failed${sqlState}.`);
        }
        persistedRowsCleaned = true;
      } finally {
        await session.close();
        sql = undefined;
      }
    }

    if (sql) {
      await sql.close();
      sql = undefined;
    }

    for (const user of [...users]) {
      await cleanupLocalUser(user.userId);
      users.splice(users.findIndex((candidate) => candidate.userId === user.userId), 1);
    }
    disposed = true;
  };

  try {
    await assertLocalSupabaseReady();
    admin = await newLocalUser();
    users.push(admin);
    workspaceName = admin.email.replace(/@example\.test$/i, "");
    if (!WORKSPACE_PATTERN.test(workspaceName) || !EMAIL_PATTERN.test(admin.email)) {
      throw new Error("Local Auth did not return a synthetic analysis fixture identity.");
    }

    const bootstrap = await admin.client.rpc("bootstrap_workspace", {
      workspace_name: workspaceName,
      full_name: "Synthetic Analysis Admin",
    });
    if (bootstrap.error || !bootstrap.data || !UUID_PATTERN.test(bootstrap.data)) {
      throw new Error("Local analysis workspace bootstrap failed.");
    }
    workspaceId = bootstrap.data;
    const confirmedWorkspaceId = await ownWorkspaceId(admin.client, admin.userId);
    if (confirmedWorkspaceId !== workspaceId) {
      throw new Error("Local analysis workspace identity did not match its persisted Profile.");
    }

    qa = await newLocalUser();
    users.push(qa);
    member = await newLocalUser();
    users.push(member);
    insertLocalProfile({
      userId: qa.userId,
      workspaceId,
      role: "QA Lead",
      fullName: "Synthetic Analysis QA",
      email: qa.email,
    });
    insertLocalProfile({
      userId: member.userId,
      workspaceId,
      role: "Member",
      fullName: "Synthetic Analysis Member",
      email: member.email,
    });

    sql = await openLocalSqlSession(localSqlName("kdm_analysis_fixture"));
    analysisId = randomUUID();
    const findingId = randomUUID();
    const evidenceId = randomUUID();
    const versions = Array.from(
      { length: options.versionCount + options.unscopedVersionCount },
      () => ({ documentId: randomUUID(), versionId: randomUUID(), chunkId: randomUUID() }),
    );

    transactionOpen = true;
    await sql.query(analysisDataSql({
      workspaceId,
      adminId: admin.userId,
      memberId: member.userId,
      status: options.status,
      withLedger: options.withLedger,
      versionCount: options.versionCount,
      versions,
      analysisId,
      findingId,
      evidenceId,
    }));
    transactionOpen = false;

    const fixture: AnalysisFixture = {
      workspaceId,
      analysisId,
      findingId,
      evidenceId,
      versions,
      admin: admin.client,
      qa: qa.client,
      member: member.client,
      adminId: admin.userId,
      qaId: qa.userId,
      memberId: member.userId,
      sql,
      dispose,
    };
    afterPersist?.({ workspaceId, analysisId, adminId: admin.userId, workspaceName });
    return fixture;
  } catch (error) {
    if (transactionOpen && sql) {
      try {
        await sql.query("rollback;");
      } catch {
        await sql.close().catch(() => undefined);
        sql = undefined;
      }
    }
    try {
      await dispose();
    } catch (cleanupError) {
      const creationFailure = error instanceof LocalSqlError
        ? `creation SQLSTATE ${error.sqlState ?? "unavailable"}`
        : "creation setup failure";
      const cleanupFailure = cleanupError instanceof LocalSqlError
        ? `cleanup SQLSTATE ${cleanupError.sqlState ?? "unavailable"}`
        : cleanupError instanceof Error && cleanupError.message.startsWith("Refusing to remove analysis rows")
          ? "workspace ownership guard rejected cleanup"
          : cleanupError instanceof Error && cleanupError.message === "Synthetic local Auth user cleanup failed."
            ? "synthetic Auth cleanup failed"
            : "local cleanup failure";
      throw new Error(`Local analysis fixture cleanup could not be verified (${creationFailure}; ${cleanupFailure}).`);
    }
    if (error instanceof InjectedAnalysisFixtureFailure) {
      throw new Error("Synthetic analysis fixture failure after persistence.");
    }
    if (error instanceof LocalSqlError) {
      throw new Error(`Local analysis fixture SQL failed${error.sqlState ? ` (SQLSTATE ${error.sqlState})` : ""}.`);
    }
    throw error instanceof Error ? error : new Error("Local analysis fixture construction failed.");
  }
}

export function createAnalysisFixture(options?: AnalysisFixtureOptions) {
  return createAnalysisFixtureInternal(options);
}

/** Test-only fault injection used to prove cleanup after committed synthetic rows. */
export async function createAnalysisFixtureWithFailureAfterPersistForTest(
  onPersist: (checkpoint: AnalysisFixtureCheckpoint) => void,
): Promise<never> {
  await createAnalysisFixtureInternal({ withLedger: true }, (checkpoint) => {
    onPersist(checkpoint);
    throw new InjectedAnalysisFixtureFailure();
  });
  throw new Error("Synthetic fixture fault injection did not interrupt construction.");
}
