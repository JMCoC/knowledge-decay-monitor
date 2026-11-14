import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { createAnalysisFixture, type AnalysisFixture } from "./analysis-fixtures";
import {
  assertLocalSupabaseReady,
  cleanupLocalUser,
  insertLocalProfile,
  newLocalUser,
} from "./local-supabase";
import { localSupabaseTarget } from "./local-supabase-target";
import { openLocalSqlSession, type LocalSqlSession } from "./local-sql-session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReviewClient = SupabaseClient<Database>;

interface PersistedReviewFixture {
  workspaceId: string;
  documentIds: string[];
  versionIds: string[];
  findingsA: {
    memberA: string[];
    memberB: string[];
    unassigned: string[];
    doc2: string[];
    doc3: string[];
  };
  mainRound: {
    id: string;
    items: string[];
    memberAItems: string[];
    submissions: string[];
    memberASubmission: string;
    memberBSubmission: string;
    reservedSubmission: string;
    expiredSubmission: string;
  };
  secondary: {
    approvedRound: string;
    approvedSubmission: string;
    approvedCandidate: string;
    approvedDecision: string;
    directRound: string;
    directSubmission: string;
    rejectedCandidate: string;
    rejectedDecision: string;
    returnedRound: string;
    returnedSubmission: string;
    invalidatedCandidate: string;
    returnId: string;
    returnState: {
      roundId: string;
      preservedSubmissions: string[];
      returnedSubmission: string | null;
      returnedRevision: number;
    };
    administrativeRound: string;
  };
}

export interface ReviewFixture {
  workspaceA: string;
  workspaceB: string;
  adminA: ReviewClient;
  qaA: ReviewClient;
  memberA: ReviewClient;
  memberA2: ReviewClient;
  documentOwnerA: ReviewClient;
  adminB: ReviewClient;
  memberB: ReviewClient;
  userIds: {
    memberA: string;
    memberA2: string;
    documentOwnerA: string;
    memberB: string;
  };
  ids: {
    findingsA: {
      memberA: string[];
      memberA2: string[];
      unassigned: string[];
      additionalDocuments: string[];
    };
    findingB: string;
    roundItemsA: { all: string[]; memberA: string[] };
    submissionsA: {
      all: string[];
      memberAGrouped: string;
      memberA2Confirmed: string;
      reserved: string;
      expired: string;
    };
    roundsA: { main: string; approved: string; direct: string; returned: string; administrative: string };
    candidatesA: { approved: string; rejected: string; invalidated: string };
    versionsA: { base: string; all: string[] };
    storagePathsA: { original: string };
    partialReturnA: {
      roundId: string;
      preservedSubmissions: string[];
      returnedRevision: number;
    };
  };
  dispose(): Promise<void>;
}

interface LocalUser {
  client: ReviewClient;
  userId: string;
  email: string;
}

function requireUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("The local review fixture received an invalid identifier.");
  return `'${value}'::uuid`;
}

function expandPsqlIncludes(fileName: string, visited = new Set<string>()): string {
  const fixtureRoot = resolve(process.cwd(), "supabase/tests/database");
  const filePath = resolve(fixtureRoot, fileName);
  if (!filePath.startsWith(`${fixtureRoot}${sep}`) || visited.has(filePath)) {
    throw new Error("The local review SQL fixture include is outside its approved directory.");
  }
  visited.add(filePath);
  const content = readFileSync(filePath, "utf8");
  return content.replace(/^\\ir ([A-Za-z0-9_.-]+)\r?$/gm, (_match, includeName: string) =>
    expandPsqlIncludes(includeName, visited));
}

function parsePersistedFixture(output: string): PersistedReviewFixture {
  const candidates = output.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  for (const candidate of candidates.reverse()) {
    try {
      const data = JSON.parse(candidate) as PersistedReviewFixture;
      if (UUID_PATTERN.test(data.workspaceId) && data.documentIds.length === 3 && data.versionIds.length === 3) {
        return data;
      }
    } catch {
      // Ignore psql status lines; only the JSON result is a fixture payload.
    }
  }
  throw new Error("The local review SQL fixture returned no verified identifier payload.");
}

function reviewDataSql(analysis: AnalysisFixture, memberA2Id: string, ownerId: string) {
  const versions = analysis.versions;
  if (versions.length !== 3) throw new Error("The local review fixture requires exactly three source documents.");
  const ids = [analysis.workspaceId, analysis.adminId, analysis.memberId, memberA2Id, ownerId, analysis.analysisId,
    versions[0].documentId, versions[1].documentId, versions[2].documentId,
    versions[0].versionId, versions[1].versionId, versions[2].versionId,
    versions[0].chunkId, versions[1].chunkId, versions[2].chunkId, analysis.findingId].map(requireUuid);
  const documentIds = `array[${ids.slice(6, 9).join(",")}]`;
  const versionIds = `array[${ids.slice(9, 12).join(",")}]`;
  const chunkIds = `array[${ids.slice(12, 15).join(",")}]`;
  const createFixtureCall = `select pg_temp.create_review_http_fixture(${[
    ...ids.slice(0, 6), documentIds, versionIds, chunkIds, ids[15],
  ].join(", ")});`;
  return [
    "\\set ON_ERROR_STOP on",
    "begin;",
    expandPsqlIncludes("review-fixtures.psql"),
    createFixtureCall,
    "commit;",
  ].join("\n");
}

function localUploadClient() {
  const target = localSupabaseTarget();
  if (!target.disposableReview) throw new Error("Review fixture storage requires the disposable review project.");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error("The local-only storage fixture credential is unavailable.");
  return createClient<Database>(target.apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

function authUsers(analysisA: AnalysisFixture, memberA2: LocalUser, ownerA: LocalUser, analysisB: AnalysisFixture) {
  return [
    analysisA.admin, analysisA.qa, analysisA.member,
    memberA2.client, ownerA.client,
    analysisB.admin, analysisB.qa, analysisB.member,
  ];
}

async function quiesceUsers(users: ReviewClient[]) {
  const outcomes = await Promise.all(users.map((client) => client.auth.signOut()));
  if (outcomes.some(({ error }) => error !== null)) {
    throw new Error("A local review fixture session could not be closed.");
  }
}

/**
 * Builds real local Auth users and committed owner-created rows. The parent
 * disposable runner destroys the project after the suite because review
 * history is append-only and deliberately cannot be deleted row by row.
 */
export async function createReviewFixture(): Promise<ReviewFixture> {
  const target = localSupabaseTarget();
  if (!target.disposableReview) {
    throw new Error("Review HTTP fixtures require the disposable S3-01 Supabase runner.");
  }
  await assertLocalSupabaseReady();

  let analysisA: AnalysisFixture | undefined;
  let analysisB: AnalysisFixture | undefined;
  let memberA2: LocalUser | undefined;
  let ownerA: LocalUser | undefined;
  let sql: LocalSqlSession | undefined;
  let uploadedPath: string | undefined;
  let uploadClient: ReturnType<typeof localUploadClient> | undefined;
  let committed = false;
  let disposed = false;

  try {
    analysisA = await createAnalysisFixture({ versionCount: 3 });
    memberA2 = await newLocalUser();
    insertLocalProfile({
      userId: memberA2.userId,
      workspaceId: analysisA.workspaceId,
      role: "Member",
      fullName: "Synthetic Review Member A2",
      email: memberA2.email,
    });
    ownerA = await newLocalUser();
    insertLocalProfile({
      userId: ownerA.userId,
      workspaceId: analysisA.workspaceId,
      role: "Member",
      fullName: "Synthetic Review Document Owner",
      email: ownerA.email,
    });

    sql = await openLocalSqlSession(`kdm_review_fixture_${randomUUID().replaceAll("-", "").slice(0, 24)}`);
    const fixtureOutput = await sql.query(reviewDataSql(analysisA, memberA2.userId, ownerA.userId));
    committed = true;
    const persisted = parsePersistedFixture(fixtureOutput);
    const expiredDeadlineQuery = `select pg_sleep(greatest(0, extract(epoch from (s.expires_at - clock_timestamp())))) from public.correction_submissions s where s.id = ${requireUuid(persisted.mainRound.expiredSubmission)};`;
    await sql.query(expiredDeadlineQuery);
    await sql.query(`select pg_temp.expire_review_reservation(${requireUuid(persisted.mainRound.expiredSubmission)});`);

    analysisB = await createAnalysisFixture({ versionCount: 1 });
    uploadClient = localUploadClient();
    const baseVersion = analysisA.versions[0].versionId;
    uploadedPath = `${analysisA.workspaceId}/${analysisA.versions[0].documentId}/${baseVersion}/original.md`;
    const upload = await uploadClient.storage.from("documents").upload(
      uploadedPath,
      new Blob(["# Synthetic private review fixture\n"], { type: "text/markdown" }),
      { contentType: "text/markdown", upsert: false },
    );
    if (upload.error) throw new Error("A synthetic private original could not be installed in local Storage.");

    const users = authUsers(analysisA, memberA2, ownerA, analysisB);
    let disposing: Promise<void> | undefined;
    const dispose = () => {
      if (disposing) return disposing;
      disposing = (async () => {
        if (disposed) return;
        if (uploadedPath && uploadClient) {
          const removal = await uploadClient.storage.from("documents").remove([uploadedPath]);
          if (removal.error) throw new Error("The synthetic review original could not be removed from local Storage.");
        }
        if (sql) {
          await sql.close();
          sql = undefined;
        }
        await quiesceUsers(users);
        // SQL history and Auth identities are removed together when the owned
        // disposable Supabase project is stopped by run-review-isolated-integration.mjs.
        disposed = true;
      })();
      return disposing;
    };

    return {
      workspaceA: analysisA.workspaceId,
      workspaceB: analysisB.workspaceId,
      adminA: analysisA.admin,
      qaA: analysisA.qa,
      memberA: analysisA.member,
      memberA2: memberA2.client,
      documentOwnerA: ownerA.client,
      adminB: analysisB.admin,
      memberB: analysisB.member,
      userIds: {
        memberA: analysisA.memberId,
        memberA2: memberA2.userId,
        documentOwnerA: ownerA.userId,
        memberB: analysisB.memberId,
      },
      ids: {
        findingsA: {
          memberA: persisted.findingsA.memberA,
          memberA2: persisted.findingsA.memberB,
          unassigned: persisted.findingsA.unassigned,
          additionalDocuments: [...persisted.findingsA.doc2, ...persisted.findingsA.doc3],
        },
        findingB: analysisB.findingId,
        roundItemsA: { all: persisted.mainRound.items, memberA: persisted.mainRound.memberAItems },
        submissionsA: {
          all: persisted.mainRound.submissions,
          memberAGrouped: persisted.mainRound.memberASubmission,
          memberA2Confirmed: persisted.mainRound.memberBSubmission,
          reserved: persisted.mainRound.reservedSubmission,
          expired: persisted.mainRound.expiredSubmission,
        },
        roundsA: {
          main: persisted.mainRound.id,
          approved: persisted.secondary.approvedRound,
          direct: persisted.secondary.directRound,
          returned: persisted.secondary.returnedRound,
          administrative: persisted.secondary.administrativeRound,
        },
        candidatesA: {
          approved: persisted.secondary.approvedCandidate,
          rejected: persisted.secondary.rejectedCandidate,
          invalidated: persisted.secondary.invalidatedCandidate,
        },
        versionsA: { base: baseVersion, all: persisted.versionIds },
        storagePathsA: { original: uploadedPath },
        partialReturnA: {
          roundId: persisted.secondary.returnState.roundId,
          preservedSubmissions: persisted.secondary.returnState.preservedSubmissions,
          returnedRevision: persisted.secondary.returnState.returnedRevision,
        },
      },
      dispose,
    };
  } catch (error) {
    if (uploadedPath && uploadClient) {
      await uploadClient.storage.from("documents").remove([uploadedPath]).catch(() => undefined);
    }
    if (sql) await sql.close().catch(() => undefined);
    if (!committed) {
      if (ownerA) await cleanupLocalUser(ownerA.userId).catch(() => undefined);
      if (memberA2) await cleanupLocalUser(memberA2.userId).catch(() => undefined);
      if (analysisB) await analysisB.dispose().catch(() => undefined);
      if (analysisA) await analysisA.dispose().catch(() => undefined);
    } else {
      const clients = [
        ...(analysisA ? [analysisA.admin, analysisA.qa, analysisA.member] : []),
        ...(memberA2 ? [memberA2.client] : []),
        ...(ownerA ? [ownerA.client] : []),
        ...(analysisB ? [analysisB.admin, analysisB.qa, analysisB.member] : []),
      ];
      await quiesceUsers(clients).catch(() => undefined);
    }
    const state = committed ? "after the synthetic review rows were committed" : "before review rows were committed";
    const code = typeof error === "object" && error !== null && "sqlState" in error
      ? ` (SQLSTATE ${String((error as { sqlState?: unknown }).sqlState ?? "unavailable")})`
      : "";
    const context = error instanceof Error && "safeContext" in error
      ? String((error as Error & { safeContext?: unknown }).safeContext ?? "")
      : "";
    const location = context && /^[a-z_]+\.[a-z_]+#\d+$/i.test(context) ? ` at ${context}` : "";
    throw new Error(`Local review fixture setup failed ${state}${code}${location}.`);
  }
}
