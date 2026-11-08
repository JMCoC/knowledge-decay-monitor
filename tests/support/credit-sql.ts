import type { AnalysisFixture } from "./analysis-fixtures";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sqlUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error("Invalid synthetic credit identifier.");
  return `'${value}'::uuid`;
}

export function insertCreditAnalysisSql(fixture: AnalysisFixture, id: string, cost: number) {
  if (!Number.isInteger(cost) || cost < 1 || cost > 2147483647) {
    throw new Error("Invalid synthetic credit cost.");
  }
  const version = fixture.versions[0];
  if (!version) throw new Error("Synthetic credit scope is unavailable.");
  return `insert into public.analyses(
    id,workspace_id,initiator_id,status,fixed_cost,reserved_credits,idempotency_key,
    request_fingerprint,retrieval_config,pricing_version,prompt_version,output_schema_version,provider_config
  ) values (${sqlUuid(id)},${sqlUuid(fixture.workspaceId)},${sqlUuid(fixture.adminId)},
    'queued',${cost},${cost},'credit-${id}','credit-${id}',
    '{"topK":5}'::jsonb,'synthetic-v1','synthetic-v1','synthetic-v1','{}'::jsonb);
  insert into public.analysis_documents(analysis_id,workspace_id,document_id,version_id,role)
    values (${sqlUuid(id)},${sqlUuid(fixture.workspaceId)},${sqlUuid(version.documentId)},${sqlUuid(version.versionId)},'source');`;
}

export function creditSnapshotSql(workspaceId: string) {
  return `select available::text || '|' || reserved::text from private.credit_balances(${sqlUuid(workspaceId)});`;
}

export function captureCreditSqlState(statements: string) {
  return `do $credit_capture$
  declare v_state text := 'ok';
  begin
    begin
      ${statements}
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate;
    end;
    perform set_config('kdm_test.credit_sqlstate', v_state, false);
  end;
  $credit_capture$;
  select current_setting('kdm_test.credit_sqlstate');`;
}

export function lastCreditSqlValue(output: string) {
  return output.split(/\r?\n/).at(-1)?.trim() ?? "";
}
