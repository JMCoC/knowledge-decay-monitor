import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/types/database";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { localSupabaseTarget } from "../support/local-supabase-target";
import { createReviewFixture, type ReviewFixture } from "../support/review-fixtures";
import { withReviewSqlSessions, type ReviewSqlSession } from "../support/review-sql-sessions";

type ReviewService = SupabaseClient<Database>;

function serviceClient(): ReviewService {
  const target = localSupabaseTarget();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!target.disposableReview || !key) throw new Error("Concurrency fixtures require the disposable review service.");
  return createClient<Database>(target.apiUrl, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

function id(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("The synthetic review fixture returned an invalid identifier.");
  }
  return `'${value}'::uuid`;
}

function text(value: string) {
  if (!/^kdm_[a-z0-9_]{8,80}$/i.test(value)) throw new Error("The synthetic review key is invalid.");
  return `'${value}'`;
}

const key = () => `kdm_${randomUUID().replaceAll("-", "")}`;

const RPC_HELPERS = `
create or replace function pg_temp.kdm_assign(p_actor uuid, p_finding uuid, p_revision bigint, p_assignee uuid, p_key text)
returns text language plpgsql as $helper$
declare v_result jsonb;
begin
  v_result := public.review_assign_finding(p_actor, p_finding, p_revision, p_assignee, p_key);
  return 'OK|' || (v_result->>'revision') || '|' || (v_result->>'severityCurrent') || '|' || (v_result->>'status') || '|' || coalesce(v_result->'assignee'->>'id', 'NONE');
exception when others then return 'SQLSTATE_' || SQLSTATE;
end;
$helper$;
create or replace function pg_temp.kdm_change(p_actor uuid, p_finding uuid, p_revision bigint, p_key text)
returns text language plpgsql as $helper$
declare v_result jsonb;
begin
  v_result := public.review_change_finding(p_actor, p_finding, p_revision, '{"field":"severity","value":"Low"}'::jsonb, p_key);
  return 'OK|' || (v_result->>'revision') || '|' || (v_result->>'severityCurrent') || '|' || (v_result->>'status');
exception when others then return 'SQLSTATE_' || SQLSTATE;
end;
$helper$;
create or replace function pg_temp.kdm_update_draft(p_actor uuid, p_round uuid, p_revision bigint, p_findings uuid[], p_key text)
returns text language plpgsql as $helper$
declare v_result jsonb;
begin
  v_result := public.review_update_round_draft(p_actor, p_round, p_revision, p_findings, p_key);
  return 'OK|' || (v_result->>'roundId') || '|' || (v_result->>'revision') || '|' || (v_result->>'status');
exception when others then return 'SQLSTATE_' || SQLSTATE;
end;
$helper$;
create or replace function pg_temp.kdm_open_round(p_actor uuid, p_round uuid, p_revision bigint, p_key text)
returns text language plpgsql as $helper$
declare v_result jsonb;
begin
  v_result := public.review_open_round(p_actor, p_round, p_revision, p_key);
  return 'OK|' || (v_result->>'roundId') || '|' || (v_result->>'revision') || '|' || (v_result->>'status');
exception when others then return 'SQLSTATE_' || SQLSTATE;
end;
$helper$;
create or replace function pg_temp.kdm_prepare_round(p_actor uuid, p_document uuid, p_finding uuid, p_key text)
returns text language plpgsql as $helper$
declare v_result jsonb;
begin
  v_result := public.review_prepare_round(p_actor, p_document, 'assigned_findings', array[p_finding], p_key);
  return 'OK|' || (v_result->>'roundId') || '|' || (v_result->>'revision') || '|' || (v_result->>'status');
exception when others then return 'SQLSTATE_' || SQLSTATE;
end;
$helper$;
create or replace function pg_temp.kdm_cancel_round(p_actor uuid, p_round uuid, p_revision bigint, p_key text)
returns text language plpgsql as $helper$
begin
  perform public.review_cancel_round(p_actor, p_round, p_revision, 'Synthetic deterministic cancellation.', p_key);
  return 'CANCELLED';
exception when others then return 'SQLSTATE_' || SQLSTATE;
end;
$helper$;
`;

async function installRpcHelpers(...sessions: ReviewSqlSession[]) {
  for (const session of sessions) await session.execute(RPC_HELPERS);
}

async function verifiedActors(fixture: ReviewFixture, service: ReviewService) {
  const [admin, qa] = await Promise.all([fixture.adminA.auth.getUser(), fixture.qaA.auth.getUser()]);
  const adminId = admin.data.user?.id;
  const qaId = qa.data.user?.id;
  if (admin.error || qa.error || !adminId || !qaId) throw new Error("Synthetic reviewer sessions could not be verified.");
  const profiles = await service.from("profiles").select("id,workspace_id,role").in("id", [adminId, qaId]);
  if (profiles.error || profiles.data?.length !== 2) throw new Error("Synthetic reviewer Profiles could not be verified.");
  const adminProfile = profiles.data.find((profile) => profile.id === adminId);
  const qaProfile = profiles.data.find((profile) => profile.id === qaId);
  if (adminProfile?.workspace_id !== fixture.workspaceA || adminProfile.role !== "Admin"
    || qaProfile?.workspace_id !== fixture.workspaceA || qaProfile.role !== "QA Lead") {
    throw new Error("Synthetic reviewers did not match their persisted workspace roles.");
  }
  return { adminId, qaId };
}

async function currentFinding(service: ReviewService, findingId: string) {
  const { data, error } = await service.from("findings").select("review_revision,assignee_id,status")
    .eq("id", findingId).single();
  if (error || !data) throw new Error("The synthetic finding revision is unavailable.");
  return data;
}

async function documentForFinding(service: ReviewService, findingId: string) {
  const { data, error } = await service.from("finding_evidence").select("document_id")
    .eq("finding_id", findingId).limit(1).single();
  if (error || !data) throw new Error("The synthetic finding document is unavailable.");
  return data.document_id;
}

async function cancelOpenFixtureRounds(fixture: ReviewFixture, service: ReviewService, actorId: string) {
  const roundIds = [fixture.ids.roundsA.main, fixture.ids.roundsA.administrative];
  for (const roundId of roundIds) {
    const { data: round, error } = await fixture.adminA.from("correction_rounds")
      .select("revision,status").eq("id", roundId).single();
    if (error || !round) throw new Error("A synthetic fixture round could not be read.");
    if (round.status === "cancelled" || round.status === "approved") continue;
    const result = await service.rpc("review_cancel_round", {
      p_actor_id: actorId,
      p_round_id: roundId,
      p_revision: round.revision,
      p_reason: "Synthetic setup cleanup before deterministic round tests.",
      p_idempotency_key: key(),
    });
    if (result.error) throw new Error(`A synthetic fixture round could not be cancelled (${result.error.code ?? "unknown"}).`);
  }
}

beforeAll(assertLocalSupabaseReady);

describe("deterministic review-command concurrency", () => {
  it("serializes competing finding revisions and replays idempotency keys without duplicate events", async () => {
    const fixture = await createReviewFixture();
    const service = serviceClient();
    try {
      const actors = await verifiedActors(fixture, service);
      await fixture.closeSqlSession();
      const findingId = fixture.ids.findingsA.memberA[0];
      const finding = await currentFinding(service, findingId);

      await withReviewSqlSessions(async (sessions) => {
        await installRpcHelpers(sessions.a, sessions.b);
        const firstKey = key();
        const secondKey = key();
        const firstCommand = await sessions.a.execute(`
          begin;
          select pg_temp.kdm_assign(${id(actors.adminId)}, ${id(findingId)}, ${finding.review_revision}, ${id(fixture.userIds.memberA2)}, ${text(firstKey)});
        `);
        const secondCommand = sessions.b.execute(`
          begin;
          select pg_temp.kdm_assign(${id(actors.qaId)}, ${id(findingId)}, ${finding.review_revision}, null::uuid, ${text(secondKey)});
          commit;
        `);
        await sessions.waitForBlockedSession(sessions.b.applicationName, 500);
        await sessions.a.execute("commit;");
        const losingCommand = await secondCommand;
        expect(firstCommand[0]).toMatch(new RegExp(`^OK\\|${finding.review_revision + 1}\\|`));
        expect(losingCommand).toEqual(["SQLSTATE_P0001"]);
      });

      const afterRace = await currentFinding(service, findingId);
      expect(afterRace.review_revision).toBe(finding.review_revision + 1);
      expect(afterRace.assignee_id).toBe(fixture.userIds.memberA2);

      const replayFindingId = fixture.ids.findingsA.memberA[1];
      const replayBefore = await currentFinding(service, replayFindingId);
      await withReviewSqlSessions(async ({ a }) => {
        await installRpcHelpers(a);
        const assignmentKey = key();
        const changeKey = key();
        const original = await a.execute(`
          select pg_temp.kdm_assign(${id(actors.adminId)}, ${id(replayFindingId)}, ${replayBefore.review_revision}, ${id(fixture.userIds.memberA2)}, ${text(assignmentKey)});
        `);
        const changed = await a.execute(`
          select pg_temp.kdm_change(${id(actors.adminId)}, ${id(replayFindingId)}, ${replayBefore.review_revision + 1}, ${text(changeKey)});
        `);
        const lostResponseReplay = await a.execute(`
          select pg_temp.kdm_assign(${id(actors.adminId)}, ${id(replayFindingId)}, ${replayBefore.review_revision}, ${id(fixture.userIds.memberA2)}, ${text(assignmentKey)});
        `);
        const changedPayloadReplay = await a.execute(`
          select pg_temp.kdm_assign(${id(actors.adminId)}, ${id(replayFindingId)}, ${replayBefore.review_revision}, null::uuid, ${text(assignmentKey)});
        `);
        expect(original[0]).toContain(`OK|${replayBefore.review_revision + 1}|`);
        expect(changed[0]).toBe(`OK|${replayBefore.review_revision + 2}|Low|confirmed`);
        expect(lostResponseReplay[0]).toBe(`OK|${replayBefore.review_revision + 2}|Low|confirmed|${fixture.userIds.memberA2}`);
        expect(changedPayloadReplay).toEqual(["SQLSTATE_P0001"]);

        const counts = await a.execute(`
          select (select count(*) from public.audit_events where entity_type='finding' and entity_id=${id(replayFindingId)} and action='finding_assigned')::text || '|' ||
            (select count(*) from public.audit_events where entity_type='finding' and entity_id=${id(replayFindingId)} and action='finding_severity_changed')::text || '|' ||
            (select count(*) from public.notification_events n join public.audit_events e on e.id=n.workflow_event_id
              where e.entity_type='finding' and e.entity_id=${id(replayFindingId)} and e.action='finding_assigned' and n.workflow_type='assignment')::text || '|' ||
            (select count(*) from private.review_commands where actor_id=${id(actors.adminId)} and idempotency_key in (${text(assignmentKey)}, ${text(changeKey)}))::text;
        `);
        expect(counts).toEqual(["1|1|1|2"]);
      });

      const replayedFinding = await currentFinding(service, replayFindingId);
      expect(replayedFinding).toMatchObject({
        review_revision: replayBefore.review_revision + 2,
        status: "confirmed",
        assignee_id: fixture.userIds.memberA2,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps draft edits and prepare operations serialized against stale open requests", async () => {
    const fixture = await createReviewFixture();
    const service = serviceClient();
    try {
      const actors = await verifiedActors(fixture, service);
      await cancelOpenFixtureRounds(fixture, service, actors.adminId);
      const findings = fixture.ids.findingsA.memberA;
      const docId = await documentForFinding(service, findings[0]);
      const prepared = await service.rpc("review_prepare_round", {
        p_actor_id: actors.adminId,
        p_document_id: docId,
        p_mode: "assigned_findings",
        p_finding_ids: [findings[0]],
        p_idempotency_key: key(),
      });
      if (prepared.error || !prepared.data || typeof prepared.data !== "object" || Array.isArray(prepared.data)) {
        throw new Error(`A synthetic review draft could not be prepared (${prepared.error?.code ?? "unknown"}).`);
      }
      const preparedData = prepared.data as { roundId: string; revision: number };

      await withReviewSqlSessions(async (sessions) => {
        await installRpcHelpers(sessions.a, sessions.b);
        const edited = await sessions.a.execute(`
          begin;
          select pg_temp.kdm_update_draft(${id(actors.adminId)}, ${id(preparedData.roundId)}, ${preparedData.revision}, array[${id(findings[0])}, ${id(findings[1])}], ${text(key())});
        `);
        const openRequest = sessions.b.execute(`
          begin;
          select pg_temp.kdm_open_round(${id(actors.qaId)}, ${id(preparedData.roundId)}, ${preparedData.revision}, ${text(key())});
          commit;
        `);
        await sessions.waitForBlockedSession(sessions.b.applicationName, 500);
        await sessions.a.execute("commit;");
        expect(edited[0]).toMatch(/^OK\|[0-9a-f-]{36}\|[0-9]+\|draft$/i);
        expect(await openRequest).toEqual(["SQLSTATE_P0001"]);
      });

      expect((await fixture.readRoundItems(preparedData.roundId)).sort()).toEqual([findings[0], findings[1]].sort());
      expect(await fixture.readRoundState(preparedData.roundId)).toMatchObject({
        status: "draft",
        revision: preparedData.revision + 1,
      });

      const docThreeFinding = fixture.ids.findingsA.additionalDocuments[3];
      const docThreeId = await documentForFinding(service, docThreeFinding);
      await withReviewSqlSessions(async (sessions) => {
        await installRpcHelpers(sessions.a, sessions.b);
        const firstPrepare = await sessions.a.execute(`
          begin;
          select pg_temp.kdm_prepare_round(${id(actors.adminId)}, ${id(docThreeId)}, ${id(docThreeFinding)}, ${text(key())});
        `);
        const secondPrepare = sessions.b.execute(`
          begin;
          select pg_temp.kdm_prepare_round(${id(actors.qaId)}, ${id(docThreeId)}, ${id(docThreeFinding)}, ${text(key())});
          commit;
        `);
        await sessions.waitForBlockedSession(sessions.b.applicationName, 500);
        await sessions.a.execute("commit;");
        expect(firstPrepare[0]).toMatch(/^OK\|[0-9a-f-]{36}\|[0-9]+\|draft$/i);
        expect(await secondPrepare).toEqual(["SQLSTATE_P0001"]);
      });
      expect(await fixture.countOpenRounds(docThreeId)).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("locks every evidence document before reservation finalization can confirm stale authorization", async () => {
    const fixture = await createReviewFixture();
    const service = serviceClient();
    try {
      const actors = await verifiedActors(fixture, service);
      const reservationAssignment = await fixture.readReservationAssignment(fixture.ids.submissionsA.reserved);
      const secondDocumentId = await fixture.addCrossDocumentEvidenceForFinding(reservationAssignment.findingId, 2);
      const finding = await currentFinding(service, reservationAssignment.findingId);
      await withReviewSqlSessions(async (sessions) => {
        await installRpcHelpers(sessions.a, sessions.b);
        await sessions.b.execute(`
          create or replace function pg_temp.kdm_finalize_reservation_contract(p_submission uuid)
          returns text language plpgsql as $contract$
          declare v_state text;
          begin
            select s.state::text into v_state from public.correction_submissions s where s.id=p_submission for update;
            if v_state <> 'reserved' then return 'STALE'; end if;
            if not exists (
              select 1 from public.correction_submission_items si
              join public.correction_round_items i on i.id=si.round_item_id and i.round_id=si.round_id
                and i.document_id=si.document_id and i.workspace_id=si.workspace_id
              where si.submission_id=p_submission and i.current_submission_id=p_submission
                and i.assignee_id=(select s.submitter_id from public.correction_submissions s where s.id=p_submission)
                and i.revision=si.expected_revision
            ) then return 'STALE'; end if;
            update public.correction_submissions set state='confirmed' where id=p_submission and state='reserved';
            return 'CONFIRMED';
          end;
          $contract$;
        `);
        await sessions.a.execute(`
          begin;
          select id from public.documents where id=${id(reservationAssignment.documentId)} for update;
          select pg_temp.kdm_assign(${id(actors.adminId)}, ${id(reservationAssignment.findingId)}, ${finding.review_revision}, ${id(fixture.userIds.memberA2)}, ${text(key())});
        `);
        const finalization = sessions.b.execute(`
          begin;
          select id from public.documents where id=${id(secondDocumentId)} for update;
          select pg_temp.kdm_finalize_reservation_contract(${id(fixture.ids.submissionsA.reserved)});
          commit;
        `);
        await sessions.waitForBlockedSession(sessions.b.applicationName, 500);
        await sessions.a.execute("commit;");
        expect(await finalization).toEqual([secondDocumentId, "STALE"]);
      });

      expect(await fixture.readSubmissionState(fixture.ids.submissionsA.reserved)).toBe("invalidated");
      const after = await currentFinding(service, reservationAssignment.findingId);
      expect(after.assignee_id).toBe(fixture.userIds.memberA2);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps cancel and candidate-selection state consistent at the round boundary", async () => {
    const fixture = await createReviewFixture();
    const service = serviceClient();
    try {
      const actors = await verifiedActors(fixture, service);
      const candidate = await fixture.createRoundWithReservedCandidate();
      const round = await fixture.readRoundState(candidate.roundId);
      expect(round.status).toBe("consolidating");

      await withReviewSqlSessions(async (sessions) => {
        await installRpcHelpers(sessions.a, sessions.b);
        await sessions.a.execute(`
          create or replace function pg_temp.kdm_select_candidate_contract(p_candidate uuid)
          returns text language plpgsql as $contract$
          declare c public.correction_candidates%rowtype; r public.correction_rounds%rowtype;
          begin
            select * into strict c from public.correction_candidates where id=p_candidate for update;
            select * into strict r from public.correction_rounds where id=c.round_id for update;
            if r.status='cancelled' or c.status<>'reserved' then return 'CANCELLED'; end if;
            update public.correction_candidates set status='selected',revision=revision+1 where id=c.id;
            insert into public.correction_candidate_items(candidate_id,round_item_id,submission_id,workspace_id,round_id,document_id,item_revision)
              select c.id,i.id,i.current_submission_id,i.workspace_id,i.round_id,i.document_id,i.coverage_revision
              from public.correction_round_items i where i.round_id=c.round_id order by i.id;
            update public.correction_rounds set status='candidate_processing',active_candidate_id=c.id,revision=revision+1 where id=r.id;
            return 'SELECTED';
          end;
          $contract$;
        `);
        await sessions.a.execute(`begin; select id from public.documents where id=${id(round.documentId)} for update;`);
        const cancellation = sessions.b.execute(`
          begin;
          select pg_temp.kdm_cancel_round(${id(actors.adminId)}, ${id(candidate.roundId)}, ${round.revision}, ${text(key())});
          commit;
        `);
        await sessions.waitForBlockedSession(sessions.b.applicationName, 500);
        const selection = await sessions.a.execute(`select pg_temp.kdm_select_candidate_contract(${id(candidate.candidateId)}); commit;`);
        expect(selection).toEqual(["SELECTED"]);
        expect(await cancellation).toEqual(["SQLSTATE_P0001"]);
      });

      const finalRound = await fixture.readRoundState(candidate.roundId);
      const finalCandidate = await fixture.readCandidateState(candidate.candidateId);
      expect(finalRound).toMatchObject({ status: "candidate_processing", activeCandidateId: candidate.candidateId });
      expect(finalCandidate.status).toBe("selected");
      expect(finalRound.status).not.toBe("cancelled");
    } finally {
      await fixture.dispose();
    }
  });

  it("rolls back finding, round items, receipt, audit, and outbox when either event sink fails", async () => {
    const fixture = await createReviewFixture();
    const service = serviceClient();
    try {
      const actors = await verifiedActors(fixture, service);
      const findingId = fixture.ids.findingsA.memberA[0];
      const revision = (await currentFinding(service, findingId)).review_revision;
      const roundId = fixture.ids.roundsA.main;
      const assignmentKey = key();
      await fixture.closeSqlSession();

      await withReviewSqlSessions(async ({ a }) => {
        await installRpcHelpers(a);
        const state = async () => a.execute(`
          select
            coalesce((select assignee_id::text || ':' || review_revision::text from public.findings where id=${id(findingId)}),'NONE') || '|' ||
            coalesce((select status::text || ':' || revision::text from public.correction_rounds where id=${id(roundId)}),'NONE') || '|' ||
            coalesce((select count(*)::text || ':' || coalesce(md5(string_agg(i.id::text || ':' || coalesce(i.assignee_id::text,'NONE') || ':' || i.revision::text || ':' || coalesce(i.current_submission_id::text,'NONE'), ',' order by i.id)),'NONE') from public.correction_round_items i where i.round_id=${id(roundId)}),'NONE') || '|' ||
            (select count(*)::text from private.review_commands where idempotency_key=${text(assignmentKey)}) || '|' ||
            (select count(*)::text from public.audit_events where entity_type='finding' and entity_id=${id(findingId)} and action='finding_assigned') || '|' ||
            (select count(*)::text from public.notification_events n join public.audit_events e on e.id=n.workflow_event_id where e.entity_type='finding' and e.entity_id=${id(findingId)} and e.action='finding_assigned');
        `);

        const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
        const auditFunction = `kdm_review_fail_audit_${suffix}`;
        const auditTrigger = `kdm_review_audit_${suffix}`;
        const outboxFunction = `kdm_review_fail_outbox_${suffix}`;
        const outboxTrigger = `kdm_review_outbox_${suffix}`;
        const baseline = await state();
        try {
          await a.execute(`
            create function public.${auditFunction}() returns trigger language plpgsql as $hook$
            begin
              if new.action='finding_assigned' and new.entity_id=${id(findingId)} then raise exception using errcode='P0001'; end if;
              return new;
            end;
            $hook$;
            create trigger ${auditTrigger} before insert on public.audit_events for each row execute function public.${auditFunction}();
          `);
          expect(await a.execute(`select pg_temp.kdm_assign(${id(actors.adminId)}, ${id(findingId)}, ${revision}, ${id(fixture.userIds.memberA2)}, ${text(assignmentKey)});`))
            .toEqual(["SQLSTATE_P0001"]);
          expect(await state()).toEqual(baseline);
        } finally {
          await a.execute(`drop trigger if exists ${auditTrigger} on public.audit_events; drop function if exists public.${auditFunction}();`);
        }

        try {
          await a.execute(`
            create function public.${outboxFunction}() returns trigger language plpgsql as $hook$
            begin
              if new.workflow_type='assignment' and new.recipient_id=${id(fixture.userIds.memberA2)} then raise exception using errcode='P0001'; end if;
              return new;
            end;
            $hook$;
            create trigger ${outboxTrigger} before insert on public.notification_events for each row execute function public.${outboxFunction}();
          `);
          expect(await a.execute(`select pg_temp.kdm_assign(${id(actors.adminId)}, ${id(findingId)}, ${revision}, ${id(fixture.userIds.memberA2)}, ${text(assignmentKey)});`))
            .toEqual(["SQLSTATE_P0001"]);
          expect(await state()).toEqual(baseline);
        } finally {
          await a.execute(`drop trigger if exists ${outboxTrigger} on public.notification_events; drop function if exists public.${outboxFunction}();`);
        }
      });
    } finally {
      await fixture.dispose();
    }
  });
});
