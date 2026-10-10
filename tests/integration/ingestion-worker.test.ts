import { beforeAll, expect, it } from "vitest";
import { assertLocalSupabaseReady, seedLocalProcessingClaim } from "../support/local-supabase";
import { openLocalSqlSession } from "../support/local-sql-session";
import { createProcessingFixture } from "../support/processing-fixtures";
import { createTestWorker } from "../support/ingestion-worker";

beforeAll(assertLocalSupabaseReady);
it("a real worker reclaims a stranded job and atomically persists actual embeddings",async()=>{
 const fixture=await createProcessingFixture({status:"processing",startedAt:new Date(Date.now()-181_000).toISOString()});
 const worker=await createTestWorker();
 try {
  await worker.start();
  await expect.poll(async()=>{
    const row=await fixture.service.from('document_versions').select('processing_status,version_status').eq('id',fixture.versionId).single();
    return row.data;
  },{timeout:30_000}).toMatchObject({processing_status:'ready',version_status:'active'});
  const chunks=await fixture.service.from('document_chunks').select('chunk_index,embedding').eq('version_id',fixture.versionId);
  expect(chunks.error).toBeNull();expect(chunks.data).toHaveLength(1);
  const vector=JSON.parse(chunks.data![0].embedding) as number[];
  expect(vector).toHaveLength(384);expect(vector.every(Number.isFinite)).toBe(true);
  expect(Math.sqrt(vector.reduce((sum,n)=>sum+n*n,0))).toBeCloseTo(1,4);
  const doc=await fixture.service.from('documents').select('active_version_id').eq('id',fixture.documentId).single();
  expect(doc.data?.active_version_id).toBe(fixture.versionId);
 } finally {await worker.stop();await fixture.dispose();}
},60_000);

it("concurrent fleet claims have one winner and heartbeat fences old attempts",async()=>{
 const fixture=await createProcessingFixture({status:'processing',startedAt:new Date(Date.now()-181_000).toISOString()});
 try {
  const claims=await Promise.all([fixture.service.rpc('claim_ingestion_job'),fixture.service.rpc('claim_ingestion_job')]);
  expect(claims.every(r=>!r.error)).toBe(true);
  expect(claims.flatMap(r=>r.data??[])).toHaveLength(1);
  const claim=claims.flatMap(r=>r.data??[])[0];
  expect((await fixture.service.rpc('heartbeat_ingestion_job',{p_version_id:fixture.versionId,p_operation_id:claim.operation_id})).data).toBe(true);
  expect((await fixture.service.rpc('heartbeat_ingestion_job',{p_version_id:fixture.versionId,p_operation_id:fixture.operationId})).data).toBe(false);
  expect((await fixture.service.rpc('finish_processing',{p_version_id:fixture.versionId,p_operation_id:fixture.operationId,p_chunks:fixture.chunks})).error?.code).toBe('22023');
  // A live job remains live beyond the old fixed 50-second budget.
  seedLocalProcessingClaim(fixture.versionId,claim.operation_id,new Date(Date.now()-90_000).toISOString());
  expect((await fixture.service.rpc('finish_processing',{p_version_id:fixture.versionId,p_operation_id:claim.operation_id,p_chunks:fixture.chunks})).error).toBeNull();
  expect((await fixture.service.rpc('finish_processing',{p_version_id:fixture.versionId,p_operation_id:claim.operation_id,p_chunks:fixture.chunks})).error).toBeNull();
  const count=await fixture.service.from('document_chunks').select('id',{count:'exact',head:true}).eq('version_id',fixture.versionId);
  expect(count.count).toBe(1);
 } finally {await fixture.dispose();}
});

it("a queue request waits for bounded completion-lock contention", async () => {
 const fixture = await createProcessingFixture({ status: "processing" });
 const holder = await openLocalSqlSession("kdm_ingestion_lock_holder");
 const observer = await openLocalSqlSession("kdm_ingestion_lock_observer");
 let hold: Promise<string> | null = null;
 try {
  hold = holder.query("begin; select pg_advisory_xact_lock(19091001); select pg_sleep(1.5); commit;");
  await expect.poll(async () => observer.query(`
   select exists(select 1 from pg_locks where pid=${holder.pid} and locktype='advisory' and granted);
  `), { timeout: 1_000 }).toBe("t");

  const enqueue = await fixture.service.rpc("enqueue_ingestion_job", {
   p_workspace_id: fixture.workspaceId,
   p_version_id: fixture.versionId,
   p_retry: true,
  });
  expect(enqueue.error).toBeNull();
  expect(enqueue.data).toBe("conflict");
  await hold;
 } finally {
  if (hold) await hold.catch(() => undefined);
  await Promise.all([observer.close(), holder.close()]);
  await fixture.dispose();
 }
}, 15_000);
