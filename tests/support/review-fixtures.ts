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
  prepareProcessingCandidate(): Promise<{ candidateId: string; versionId: string; roundId: string; submissionId: string }>;
  completeProcessingCandidate(candidateId: string): Promise<void>;
  createRoundWithReservedCandidate(): Promise<{ candidateId: string; versionId: string; roundId: string }>;
  addCrossDocumentEvidenceForFinding(findingId: string, documentOrdinal?: 2 | 3): Promise<string>;
  readReservationAssignment(submissionId: string): Promise<{
    roundItemId: string;
    findingId: string;
    documentId: string;
    itemRevision: number;
    expectedRevision: number;
  }>;
  readSubmissionState(submissionId: string): Promise<string>;
  readSubmissionVersion(submissionId: string): Promise<string>;
  readRoundItems(roundId: string): Promise<string[]>;
  countOpenRounds(documentId: string): Promise<number>;
  readCandidateState(candidateId: string): Promise<{
    id: string;
    status: string;
    versionId: string;
    sourceSubmissionId: string | null;
    selectedBy: string;
  }>;
  readVersionState(versionId: string): Promise<{ id: string; processingStatus: string; versionStatus: string | null }>;
  readRoundState(roundId: string): Promise<{
    status: string;
    activeCandidateId: string | null;
    documentId: string;
    revision: number;
  }>;
  closeSqlSession(): Promise<void>;
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
    const analysisAFixture = analysisA;
    const verifiedAdminId = analysisA.adminId;
    const prepareProcessingCandidate = async () => {
      if (!sql) throw new Error("The local review SQL fixture session is closed.");
      const output = await sql.query([
        "\\set ON_ERROR_STOP on",
        `select revision as previous_round_revision from public.correction_rounds where id=${requireUuid(persisted.mainRound.id)} \\gset`,
        `select (public.review_cancel_round(${requireUuid(verifiedAdminId)}, ${requireUuid(persisted.mainRound.id)}, :'previous_round_revision'::bigint, 'Synthetic candidate fixture preparation.', 'kdm_fixture_cancel_main')->>'status');`,
        `select pg_temp.create_review_round_for_document(${requireUuid(analysisAFixture.workspaceId)}, ${requireUuid(analysisAFixture.versions[0].documentId)}, ${requireUuid(verifiedAdminId)}, 'assigned_findings', array[${persisted.findingsA.memberA.map(requireUuid).join(", ")}]) as new_round_id \\gset`,
        "select array_agg(i.id order by i.finding_id)::text as new_item_ids from public.correction_round_items i where i.round_id=:'new_round_id'::uuid \\gset",
        `select pg_temp.create_review_submission(:'new_round_id'::uuid, ${requireUuid(analysisAFixture.memberId)}, :'new_item_ids'::uuid[]) as new_submission_id \\gset`,
        `select pg_temp.select_direct_review_candidate(:'new_round_id'::uuid, ${requireUuid(verifiedAdminId)}, :'new_submission_id'::uuid) as candidate_id \\gset`,
        "select pg_temp.start_review_candidate(:'candidate_id'::uuid);",
        "select c.id::text || '|' || c.version_id::text || '|' || c.round_id::text || '|' || c.source_submission_id::text from public.correction_candidates c where c.id = :'candidate_id'::uuid;",
      ].join("\n"));
      const match = output.match(/([0-9a-f-]{36})\|([0-9a-f-]{36})\|([0-9a-f-]{36})\|([0-9a-f-]{36})/i);
      if (!match) throw new Error("The local review fixture did not produce a synthetic processing candidate.");
      return { candidateId: match[1], versionId: match[2], roundId: match[3], submissionId: match[4] };
    };
    const completeProcessingCandidate = async (candidateId: string) => {
      if (!UUID_PATTERN.test(candidateId) || !sql) throw new Error("A local synthetic candidate is required.");
      await sql.query(`select pg_temp.complete_review_candidate(${requireUuid(candidateId)});`);
      const output = await sql.query(`select status::text from public.correction_candidates where id = ${requireUuid(candidateId)};`);
      if (output.trim() !== "pending_approval") throw new Error("The synthetic review candidate did not reach pending approval.");
    };
    const createRoundWithReservedCandidate = async () => {
      if (!sql) throw new Error("The local review SQL fixture session is closed.");
      let output: string;
      try {
        output = await sql.query([
        `select revision as previous_round_revision from public.correction_rounds where id=${requireUuid(persisted.secondary.administrativeRound)} \\gset`,
        `select (public.review_cancel_round(${requireUuid(verifiedAdminId)}, ${requireUuid(persisted.secondary.administrativeRound)}, :'previous_round_revision'::bigint, 'Synthetic candidate selection fixture preparation.', 'kdm_fixture_cancel_admin')->>'status');`,
        `select (public.review_prepare_round(${requireUuid(verifiedAdminId)}, ${requireUuid(analysisAFixture.versions[2].documentId)}, 'administrative', '{}'::uuid[], 'kdm_fixture_candidate_prepare')->>'roundId') as new_round_id \\gset`,
        `select (public.review_open_round(${requireUuid(verifiedAdminId)}, :'new_round_id'::uuid, (select revision from public.correction_rounds where id=:'new_round_id'::uuid), 'kdm_fixture_candidate_open')->>'status');`,
        `select pg_temp.create_consolidated_candidate(:'new_round_id'::uuid, ${requireUuid(verifiedAdminId)}, true) as candidate_id \\gset`,
        "select c.id::text || '|' || c.version_id::text || '|' || c.round_id::text from public.correction_candidates c where c.id = :'candidate_id'::uuid;",
        ].join("\n"));
      } catch (error) {
        const sqlState = typeof error === "object" && error !== null && "sqlState" in error
          ? String((error as { sqlState?: unknown }).sqlState ?? "unknown")
          : "unknown";
        const context = typeof error === "object" && error !== null && "safeContext" in error
          ? String((error as { safeContext?: unknown }).safeContext ?? "")
          : "";
        const safeLocation = /^[a-z_]+\.[a-z_]+#\d+$/i.test(context) ? ` at ${context}` : "";
        throw new Error(`Reserved candidate fixture failed (SQLSTATE ${sqlState})${safeLocation}.`);
      }
      const match = output.match(/([0-9a-f-]{36})\|([0-9a-f-]{36})\|([0-9a-f-]{36})/i);
      if (!match) throw new Error("The local review fixture did not produce a reserved candidate round.");
      return { candidateId: match[1], versionId: match[2], roundId: match[3] };
    };
    const addCrossDocumentEvidenceForFinding = async (findingId: string, documentOrdinal: 2 | 3 = 2) => {
      if (!sql || !persisted.findingsA.memberA.includes(findingId)) {
        throw new Error("Cross-document evidence requires a synthetic assigned finding.");
      }
      const version = analysisAFixture.versions[documentOrdinal - 1];
      const output = await sql.query(`select pg_temp.insert_evidence_row(
        ${requireUuid(analysisAFixture.workspaceId)}, ${requireUuid(analysisAFixture.analysisId)}, ${requireUuid(findingId)},
        ${requireUuid(version.documentId)}, ${requireUuid(version.versionId)}, ${requireUuid(version.chunkId)},
        'Synthetic cross-document review evidence'
      )::text;`);
      const evidenceId = output.trim();
      if (!UUID_PATTERN.test(evidenceId)) throw new Error("Cross-document review evidence was not persisted.");
      return version.documentId;
    };
    const readReservationAssignment = async (submissionId: string) => {
      if (!sql || !UUID_PATTERN.test(submissionId)) throw new Error("A synthetic reservation is required for this local read.");
      const values = (await sql.query(`
        select si.round_item_id::text || '|' || i.finding_id::text || '|' || i.document_id::text || '|' || i.revision::text || '|' || si.expected_revision::text
        from public.correction_submission_items si join public.correction_round_items i on i.id=si.round_item_id
        where si.submission_id=${requireUuid(submissionId)};
      `)).trim().split("|");
      if (values.length !== 5 || !UUID_PATTERN.test(values[0]) || !UUID_PATTERN.test(values[1]) || !UUID_PATTERN.test(values[2])
        || !/^\d+$/.test(values[3]) || !/^\d+$/.test(values[4])) {
        throw new Error("The local synthetic reservation returned an invalid assignment marker.");
      }
      return {
        roundItemId: values[0],
        findingId: values[1],
        documentId: values[2],
        itemRevision: Number(values[3]),
        expectedRevision: Number(values[4]),
      };
    };
    const readSubmissionState = async (submissionId: string) => {
      if (!sql || !UUID_PATTERN.test(submissionId)) throw new Error("A synthetic submission is required for this local read.");
      const state = (await sql.query(`select state::text from public.correction_submissions where id=${requireUuid(submissionId)};`)).trim();
      if (!/^(reserved|confirmed|expired|invalidated)$/.test(state)) {
        throw new Error("The local synthetic submission returned an invalid state marker.");
      }
      return state;
    };
    const readSubmissionVersion = async (submissionId: string) => {
      if (!sql || !UUID_PATTERN.test(submissionId)) throw new Error("A synthetic submission is required for this local read.");
      const versionId = (await sql.query(`select version_id::text from public.correction_submissions where id=${requireUuid(submissionId)};`)).trim();
      if (!UUID_PATTERN.test(versionId)) throw new Error("The local synthetic submission returned an invalid version marker.");
      return versionId;
    };
    const readRoundItems = async (roundId: string) => {
      if (!sql || !UUID_PATTERN.test(roundId)) throw new Error("A synthetic round is required for this local read.");
      const output = (await sql.query(`select coalesce(string_agg(finding_id::text, '|' order by finding_id), '') from public.correction_round_items where round_id=${requireUuid(roundId)};`)).trim();
      const findingIds = output ? output.split("|") : [];
      if (findingIds.some((findingId) => !UUID_PATTERN.test(findingId))) {
        throw new Error("The local synthetic round returned an invalid finding marker.");
      }
      return findingIds;
    };
    const countOpenRounds = async (documentId: string) => {
      if (!sql || !UUID_PATTERN.test(documentId)) throw new Error("A synthetic document is required for this local read.");
      const count = (await sql.query(`select count(*)::text from public.correction_rounds where document_id=${requireUuid(documentId)} and status not in ('approved','cancelled');`)).trim();
      if (!/^\d+$/.test(count)) throw new Error("The local synthetic document returned an invalid active-round count.");
      return Number(count);
    };
    const readCandidateState = async (candidateId: string) => {
      if (!sql || !UUID_PATTERN.test(candidateId)) throw new Error("A synthetic candidate is required for this local read.");
      const values = (await sql.query(`select id::text || '|' || status::text || '|' || version_id::text || '|' || coalesce(source_submission_id::text,'NONE') || '|' || selected_by::text from public.correction_candidates where id=${requireUuid(candidateId)};`)).trim().split("|");
      if (values.length !== 5 || !UUID_PATTERN.test(values[0]) || !UUID_PATTERN.test(values[2]) || !UUID_PATTERN.test(values[4])
        || !/^(reserved|selected|processing|failed|pending_approval|approved|rejected|invalidated)$/.test(values[1])
        || (values[3] !== "NONE" && !UUID_PATTERN.test(values[3]))) {
        throw new Error("The local synthetic candidate returned an invalid state marker.");
      }
      return {
        id: values[0],
        status: values[1],
        versionId: values[2],
        sourceSubmissionId: values[3] === "NONE" ? null : values[3],
        selectedBy: values[4],
      };
    };
    const readVersionState = async (versionId: string) => {
      if (!sql || !UUID_PATTERN.test(versionId)) throw new Error("A synthetic version is required for this local read.");
      const values = (await sql.query(`select id::text || '|' || processing_status::text || '|' || coalesce(version_status::text,'NONE') from public.document_versions where id=${requireUuid(versionId)};`)).trim().split("|");
      if (values.length !== 3 || !UUID_PATTERN.test(values[0])
        || !/^(uploaded|processing|processing_failed|ready)$/.test(values[1])
        || (values[2] !== "NONE" && !/^(active|historical|pending_approval|rejected)$/.test(values[2]))) {
        throw new Error("The local synthetic version returned an invalid state marker.");
      }
      return { id: values[0], processingStatus: values[1], versionStatus: values[2] === "NONE" ? null : values[2] };
    };
    const readRoundState = async (roundId: string) => {
      if (!sql || !UUID_PATTERN.test(roundId)) throw new Error("A synthetic round is required for this local read.");
      const values = (await sql.query(`select document_id::text || '|' || status::text || '|' || coalesce(active_candidate_id::text,'NONE') || '|' || revision::text from public.correction_rounds where id=${requireUuid(roundId)};`)).trim().split("|");
      if (values.length !== 4 || !UUID_PATTERN.test(values[0])
        || !/^(draft|collecting|consolidating|candidate_processing|candidate_failed|pending_approval|approved|cancelled)$/.test(values[1])
        || (values[2] !== "NONE" && !UUID_PATTERN.test(values[2])) || !/^\d+$/.test(values[3])) {
        throw new Error("The local synthetic round returned an invalid state marker.");
      }
      return {
        documentId: values[0],
        status: values[1],
        activeCandidateId: values[2] === "NONE" ? null : values[2],
        revision: Number(values[3]),
      };
    };
    const closeSqlSession = async () => {
      if (!sql) return;
      const activeSession = sql;
      sql = undefined;
      await activeSession.close();
    };
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
      prepareProcessingCandidate,
      completeProcessingCandidate,
      createRoundWithReservedCandidate,
      addCrossDocumentEvidenceForFinding,
      readReservationAssignment,
      readSubmissionState,
      readSubmissionVersion,
      readRoundItems,
      countOpenRounds,
      readCandidateState,
      readVersionState,
      readRoundState,
      closeSqlSession,
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
