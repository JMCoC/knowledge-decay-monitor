import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({download:vi.fn(),parse:vi.fn(),chunk:vi.fn()}));
vi.mock("@/modules/ingestion/storage",()=>({downloadStorageObject:mocks.download}));
vi.mock("@/modules/ingestion/chunking",()=>({ParseError:class extends Error{},parseDocument:mocks.parse,chunkDeterministic:mocks.chunk}));
import { ParseError } from "@/modules/ingestion/chunking";
import { processJob, type IngestionJob } from "@/modules/ingestion/worker/process-job";
const job:IngestionJob={version_id:'v',workspace_id:'w',operation_id:'op',started_at:new Date().toISOString()};
function serviceFixture(){
 const queryResults:unknown[]=[{data:{id:'v',workspace_id:'w',document_id:'d',storage_path:'w/d/v/original.md',upload_state:'confirmed',processing_status:'processing',processing_operation_id:'op'},error:null}];
 const builder:Record<string,unknown>={};
 for(const method of ['select','eq','abortSignal']) builder[method]=()=>builder;
 builder.single=builder.maybeSingle=()=>Promise.resolve(queryResults.shift());
 const rpc=vi.fn<(name:string,...args:unknown[])=>{abortSignal():Promise<{data?:string,error:unknown}>}>((name:string)=>({abortSignal:()=>Promise.resolve(name==='finish_processing'?{error:null}:{data:'queued',error:null})}));
 return {service:{from:()=>builder,rpc},rpc,queryResults};
}
beforeEach(()=>{mocks.download.mockReset().mockResolvedValue(new Response('synthetic'));mocks.parse.mockReset().mockResolvedValue({sections:[]});mocks.chunk.mockReset().mockReturnValue([{chunk_index:0,text_content:'synthetic',page_number:null,section_heading:null}]);});
describe('durable job processing',()=>{
 it('persists all chunks through atomic completion',async()=>{
  const {service,rpc}=serviceFixture();
  expect(await processJob(job,service as never,async()=>[Array(384).fill(0)],new AbortController().signal)).toBe('completed');
  expect(rpc.mock.calls[0][0]).toBe('finish_processing');
 });
 it('treats rejected content as terminal without exposing provider errors',async()=>{
  const {service,rpc}=serviceFixture();mocks.parse.mockRejectedValue(new ParseError('NO_TEXT','Synthetic'));
  await processJob(job,service as never,vi.fn(),new AbortController().signal);
  expect(rpc).toHaveBeenCalledWith('fail_ingestion_job',{p_version_id:'v',p_operation_id:'op',p_retryable:false});
 });
 it('bounds technical retry and never finalizes partial embeddings',async()=>{
  const {service,rpc}=serviceFixture();
  expect(await processJob(job,service as never,async()=>{throw new Error('private body');},new AbortController().signal)).toBe('queued');
  expect(rpc).toHaveBeenCalledWith('fail_ingestion_job',{p_version_id:'v',p_operation_id:'op',p_retryable:true});
  expect(rpc.mock.calls.some(([name])=>name==='finish_processing')).toBe(false);
 });
 it('never writes after cancellation',async()=>{
  const {service,rpc}=serviceFixture();
  expect(await processJob(job,service as never,vi.fn(),AbortSignal.abort())).toBe('superseded');
  expect(rpc).not.toHaveBeenCalled();
 });
 it('reconciles a completion response lost after commit',async()=>{
  const {service,rpc,queryResults}=serviceFixture();
  rpc.mockImplementation(()=>({abortSignal:()=>Promise.reject(new Error('private transport'))}));
  queryResults.push({data:{processing_status:'ready',version_status:'active'},error:null},{data:{active_version_id:'v'},error:null});
  expect(await processJob(job,service as never,async()=>[Array(384).fill(0)],new AbortController().signal)).toBe('completed');
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it('leaves uncertainty for lease recovery when reconciliation is unavailable',async()=>{
  const {service,rpc,queryResults}=serviceFixture();
  rpc.mockImplementation(()=>({abortSignal:()=>Promise.resolve({error:{message:'private'}})}));
  queryResults.push({data:null,error:{message:'private'}});
  expect(await processJob(job,service as never,async()=>[Array(384).fill(0)],new AbortController().signal)).toBe('uncertain');
  expect(rpc).toHaveBeenCalledTimes(1);
 });
});
