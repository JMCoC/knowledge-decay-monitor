import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import {
  assertLocalSupabaseReady,
  cleanupLocalUser,
  newLocalUser,
  ownWorkspaceId,
} from "./local-supabase";
import { openLocalSqlSession, type LocalSqlSession } from "./local-sql-session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_PATTERN = /^kdm-[0-9a-f-]{36}$/i;
const EMAIL_PATTERN = /^kdm-[0-9a-f-]{36}@example\.test$/i;
const EMBEDDING = `[1,${Array.from({ length: 383 }, () => "0").join(",")}]`;

export interface AnalysisCapacityFixtureOptions {
  versionCount: number;
  chunksPerVersion: number;
  sqlQueryTimeoutMs?: number;
}

export interface AnalysisCapacityFixture {
  workspaceId: string;
  analysisId: string;
  versionIds: string[];
  admin: SupabaseClient<Database>;
  sql: LocalSqlSession;
  dispose(): Promise<void>;
}

interface LocalAdmin {
  client: SupabaseClient<Database>;
  userId: string;
  email: string;
}

function sqlLiteral(value: string) {
  if (value.includes("\0")) throw new Error("Invalid local capacity fixture value.");
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid local capacity fixture identifier.");
  return `${sqlLiteral(value)}::uuid`;
}

function orderedChunkUuid(group: "10000000" | "f0000000") {
  const suffix = randomUUID().split("-").slice(1).join("-");
  return `${group}-${suffix}`;
}

function fixtureSql(input: {
  workspaceId: string;
  adminId: string;
  versionCount: number;
  chunksPerVersion: number;
}) {
  const workspaceId = sqlUuid(input.workspaceId);
  const adminId = sqlUuid(input.adminId);
  const statements = ["begin;"];
  const chunkStatements: string[] = [];
  const documents = Array.from({ length: input.versionCount }, () => ({
    documentId: randomUUID(),
    versionId: randomUUID(),
  }));
  const analysisId = randomUUID();

  for (const [index, row] of documents.entries()) {
    statements.push(
      `insert into public.documents(id,workspace_id,name,category,owner_id) values (`
        + `${sqlUuid(row.documentId)},${workspaceId},${sqlLiteral(`Capacity synthetic ${index + 1}`)},'SOP',${adminId});`,
      `insert into public.document_versions(id,workspace_id,document_id,version_number,storage_path,processing_status,version_status) values (`
        + `${sqlUuid(row.versionId)},${workspaceId},${sqlUuid(row.documentId)},1,`
        + `${sqlLiteral(`${input.workspaceId}/${row.documentId}/${row.versionId}/original.md`)},'ready','active');`,
      `update public.documents set active_version_id=${sqlUuid(row.versionId)} `
        + `where id=${sqlUuid(row.documentId)} and workspace_id=${workspaceId};`,
    );
  }

  statements.push(
    `insert into public.analyses(
      id,workspace_id,initiator_id,fixed_cost,reserved_credits,idempotency_key,
      request_fingerprint,retrieval_config,pricing_version,prompt_version,
      output_schema_version,provider_config
    ) values (
      ${sqlUuid(analysisId)},${workspaceId},${adminId},1,1,${sqlLiteral(`capacity-${analysisId}`)},
      repeat('a',64),'{}'::jsonb,'s2-04-v1','capacity-local-v1','capacity-local-v1',
      '{"primary":{"provider":"fake","model":"capacity"},"fallback":{"provider":"fake","model":"capacity"}}'::jsonb
    );`,
  );
  for (const [index, row] of documents.entries()) {
    statements.push(
      `insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role) values (`
        + `${sqlUuid(analysisId)},${workspaceId},${sqlUuid(row.documentId)},${sqlUuid(row.versionId)},`
        + `${index === 0 ? "'source'" : "'comparison'"});`,
    );
  }

  for (const [versionIndex, row] of documents.entries()) {
    const group = versionIndex === 0 ? "f0000000" : "10000000";
    for (let batchStart = 0; batchStart < input.chunksPerVersion; batchStart += 250) {
      const batchEnd = Math.min(batchStart + 250, input.chunksPerVersion);
      const values: string[] = [];
      for (let chunkIndex = batchStart; chunkIndex < batchEnd; chunkIndex += 1) {
        values.push(`(${sqlUuid(orderedChunkUuid(group))},${workspaceId},${sqlUuid(row.versionId)},`
          + `${chunkIndex},${sqlLiteral("Synthetic capacity measurement chunk")},1,'Capacity fixture',`
          + `${sqlLiteral(EMBEDDING)}::extensions.vector(384))`);
      }
      chunkStatements.push(
        `insert into public.document_chunks(id,workspace_id,version_id,chunk_index,text_content,page_number,section_heading,embedding) values ${values.join(",")};`,
      );
    }
  }
  return {
    setupSql: statements.join("\n"),
    chunkStatements,
    analysisId,
    versionIds: documents.map((row) => row.versionId),
  };
}

export async function createAnalysisCapacityFixture(
  options: AnalysisCapacityFixtureOptions,
): Promise<AnalysisCapacityFixture> {
  if (!Number.isInteger(options.versionCount) || options.versionCount < 1 || options.versionCount > 20
    || !Number.isInteger(options.chunksPerVersion) || options.chunksPerVersion < 1 || options.chunksPerVersion > 500) {
    throw new Error("Local analysis capacity fixtures are limited to 20 versions and 500 chunks per version.");
  }

  let admin: LocalAdmin | undefined;
  let workspaceId: string | undefined;
  let workspaceName: string | undefined;
  let analysisId: string | undefined;
  let sql: LocalSqlSession | undefined;
  let transactionOpen = false;
  let workspaceCleaned = false;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    const cleanupFailures: string[] = [];
    if (sql) {
      if (analysisId) {
        try {
          await sql.query(`
            begin;
            delete from public.analysis_documents where analysis_id = '${analysisId}'::uuid;
            delete from public.analyses where id = '${analysisId}'::uuid;
            commit;
          `);
        } catch {
          cleanupFailures.push("analysis");
        }
      }
      try {
        await sql.close();
      } catch {
        cleanupFailures.push("sql_session");
      } finally {
        sql = undefined;
      }
    }
    if (workspaceId && admin && workspaceName && !workspaceCleaned) {
      // cleanupLocalUser verifies the exact generated Admin/workspace marker,
      // then removes only that synthetic local workspace and its documents.
      if (!WORKSPACE_PATTERN.test(workspaceName) || !EMAIL_PATTERN.test(admin.email)) {
        cleanupFailures.push("identity_guard");
      } else {
        try {
          await cleanupLocalUser(admin.userId);
          workspaceCleaned = true;
        } catch {
          cleanupFailures.push("workspace");
        }
      }
    }
    if (cleanupFailures.length > 0) {
      throw new Error(`Local capacity fixture cleanup failed (${cleanupFailures.join(",")}).`);
    }
    disposed = true;
  };

  try {
    await assertLocalSupabaseReady();
    admin = await newLocalUser();
    workspaceName = admin.email.replace(/@example\.test$/i, "");
    if (!WORKSPACE_PATTERN.test(workspaceName) || !EMAIL_PATTERN.test(admin.email)) {
      throw new Error("Local Auth did not return a synthetic capacity fixture identity.");
    }

    const bootstrap = await admin.client.rpc("bootstrap_workspace", {
      workspace_name: workspaceName,
      full_name: "Synthetic Capacity Admin",
    });
    if (bootstrap.error || !bootstrap.data || !UUID_PATTERN.test(bootstrap.data)) {
      throw new Error("Local capacity workspace bootstrap failed.");
    }
    workspaceId = bootstrap.data;
    if (await ownWorkspaceId(admin.client, admin.userId) !== workspaceId) {
      throw new Error("Local capacity workspace identity did not match its persisted Profile.");
    }

    sql = await openLocalSqlSession(
      `kdm_capacity_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      { queryTimeoutMs: options.sqlQueryTimeoutMs },
    );
    const fixture = fixtureSql({
      workspaceId,
      adminId: admin.userId,
      versionCount: options.versionCount,
      chunksPerVersion: options.chunksPerVersion,
    });
    analysisId = fixture.analysisId;
    transactionOpen = true;
    await sql.query(fixture.setupSql);
    for (const chunkStatement of fixture.chunkStatements) await sql.query(chunkStatement);
    await sql.query("commit;");
    transactionOpen = false;

    return {
      workspaceId,
      analysisId,
      versionIds: fixture.versionIds,
      admin: admin.client,
      sql,
      dispose,
    };
  } catch (error) {
    let cleanupFailureCount = 0;
    if (transactionOpen && sql) {
      try {
        await sql.query("rollback;");
      } catch {
        cleanupFailureCount += 1;
      }
    }
    if (sql) {
      if (analysisId) {
        try {
          await sql.query(`
            begin;
            delete from public.analysis_documents where analysis_id = '${analysisId}'::uuid;
            delete from public.analyses where id = '${analysisId}'::uuid;
            commit;
          `);
        } catch {
          cleanupFailureCount += 1;
        }
      }
      try {
        await sql.close();
      } catch {
        cleanupFailureCount += 1;
      } finally {
        sql = undefined;
      }
    }
    if (admin) {
      if (!WORKSPACE_PATTERN.test(workspaceName ?? "") || !EMAIL_PATTERN.test(admin.email)) {
        cleanupFailureCount += 1;
      } else {
        try {
          await cleanupLocalUser(admin.userId);
        } catch {
          cleanupFailureCount += 1;
        }
      }
    }
    if (cleanupFailureCount > 0) {
      throw new Error(`Local analysis capacity fixture construction failed; cleanup also failed (${cleanupFailureCount} operation(s)).`);
    }
    throw error instanceof Error ? error : new Error("Local analysis capacity fixture construction failed.");
  }
}
