import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({download:vi.fn(),parse:vi.fn(),chunk:vi.fn()}));
vi.mock("@/modules/ingestion/storage",()=>({downloadStorageObject:mocks.download}));
vi.mock("@/modules/ingestion/chunking",()=>({ParseError:class extends Error{},parseDocument:mocks.parse,chunkDeterministic:mocks.chunk}));
import { processJob, type IngestionJob } from "@/modules/ingestion/worker/process-job";
const job:IngestionJob={version_id:'v',workspace_id:'w',operation_id:'op',started_at:new Date().toISOString()};
type QueryResult={data:unknown,error:unknown};
function serviceFixture(workflowKind:string,results:QueryResult[]){
 const queryResults:QueryResult[]=[{data:{id:'v',workspace_id:'w',document_id:'d',storage_path:'w/d/v/original.md',upload_state:'confirmed',processing_status:'processing',processing_operation_id:'op',workflow_kind:workflowKind},error:null},...results];
 const builder:Record<string,unknown>={};
 for(const method of ['select','eq','abortSignal']) builder[method]=()=>builder;
 builder.single=builder.maybeSingle=()=>Promise.resolve(queryResults.shift());
 const rpc=vi.fn<(name:string,...args:unknown[])=>{abortSignal():Promise<{data?:string,error:unknown}>}>((name:string)=>({abortSignal:()=>Promise.resolve(name==='finish_processing'?{error:{message:'private transport'}}:{data:'failed',error:null})}));
 return {service:{from:()=>builder,rpc},rpc,queryResults};
}
beforeEach(()=>{mocks.download.mockReset().mockResolvedValue(new Response('synthetic'));mocks.parse.mockReset().mockResolvedValue({sections:[]});mocks.chunk.mockReset().mockReturnValue([{chunk_index:0,text_content:'synthetic',page_number:null,section_heading:null}]);});
describe('correction completion verification',()=>{
 it('completes an initial version when it is the active document version',async()=>{
  const {service}=serviceFixture('initial',[
   {data:{processing_status:'ready',version_status:'active',processing_operation_id:'op'},error:null},
   {data:{active_version_id:'v'},error:null},
  ]);
  expect(await processJob(job,service as never,async()=>[Array(384).fill(0)],new AbortController().signal)).toBe('completed');
 });
 it('completes an uncertain correction completion when candidate and round remain correct',async()=>{
  const {service,rpc}=serviceFixture('correction_candidate',[
   {data:{processing_status:'ready',version_status:'pending_approval',processing_operation_id:'op'},error:null},
   {data:{id:'c',round_id:'r'},error:null},
   {data:{status:'pending_approval',active_candidate_id:'c'},error:null},
  ]);
  expect(await processJob(job,service as never,async()=>[Array(384).fill(0)],new AbortController().signal)).toBe('completed');
  expect(rpc.mock.calls.some(([name])=>name==='fail_ingestion_job')).toBe(false);
 });
 it('leaves a correction candidate uncertain when its round no longer points at it',async()=>{
  const {service}=serviceFixture('correction_candidate',[
   {data:{processing_status:'ready',version_status:'pending_approval',processing_operation_id:'op'},error:null},
   {data:{id:'c',round_id:'r'},error:null},
   {data:{status:'candidate_processing',active_candidate_id:'c'},error:null},
  ]);
  expect(await processJob(job,service as never,async()=>[Array(384).fill(0)],new AbortController().signal)).toBe('uncertain');
 });
 it('rejects an unsupported workflow kind after an uncertain completion',async()=>{
  const {service,rpc}=serviceFixture('correction_submission',[]);
  await expect(processJob(job,service as never,async()=>[Array(384).fill(0)],new AbortController().signal))
   .rejects.toThrow('UNSUPPORTED_WORKFLOW_KIND');
  expect(rpc.mock.calls.some(([name])=>name==='fail_ingestion_job')).toBe(false);
 });
});
