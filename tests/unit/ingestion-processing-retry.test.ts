import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({rpc:vi.fn(),result:{data:"queued",error:null} as {data:string|null,error:unknown}}));
vi.mock("@/lib/supabase/service",()=>({createServiceClient:()=>({rpc:(...args:unknown[])=>{mocks.rpc(...args);return {abortSignal:()=>Promise.resolve(mocks.result)};}})}));
import { claimProcessingRetry } from "@/modules/ingestion/processing-retry";
beforeEach(()=>{vi.clearAllMocks();mocks.result={data:"queued",error:null};});
it.each(["queued","conflict","not_found"])("returns controlled SQL outcome %s",async(kind)=>{
 mocks.result.data=kind;
 expect(await claimProcessingRetry({workspaceId:"verified",versionId:"v"})).toEqual({kind});
 expect(mocks.rpc).toHaveBeenCalledWith("enqueue_ingestion_job",{p_workspace_id:"verified",p_version_id:"v",p_retry:true});
});
it("does not leak a provider exception",async()=>{
 mocks.result.error={message:"private SQL"};
 await expect(claimProcessingRetry({workspaceId:"w",versionId:"v"})).rejects.toThrow("Retry could not be queued.");
});
