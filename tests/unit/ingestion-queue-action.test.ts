import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({actor:vi.fn(),enqueue:vi.fn(),finalize:vi.fn()}));
vi.mock("@/modules/identity",()=>({IdentityError:class extends Error{},requireDocumentActor:mocks.actor}));
vi.mock("@/modules/ingestion/processing-retry",()=>({claimProcessingRetry:mocks.enqueue}));
vi.mock("@/modules/ingestion/upload-store",()=>({UploadStoreError:class extends Error{},computeRequestFingerprint:vi.fn(),reserveUploadRecord:vi.fn(),getUploadSnapshot:vi.fn(),resumeUploadRecord:vi.fn(),recoverUploadRecord:vi.fn(),finalizeUploadRecord:mocks.finalize}));
vi.mock("@/lib/observability/operation-events",()=>({captureOperationFailure:vi.fn()}));
import { retryProcessing,finalizeUpload } from "@/modules/ingestion/actions";
const versionId="30000000-0000-4000-8000-000000000010";
beforeEach(()=>{vi.clearAllMocks();mocks.actor.mockResolvedValue({userId:'u',workspaceId:'verified-workspace',role:'Admin'});mocks.enqueue.mockResolvedValue({kind:'queued'});});
describe("durable queue actions",()=>{
 it("queues a retry using persisted actor tenant and returns immediately",async()=>{
   expect(await retryProcessing(versionId)).toEqual({ok:true,data:{versionId,processingStatus:'queued'}});
   expect(mocks.enqueue).toHaveBeenCalledWith({workspaceId:'verified-workspace',versionId});
 });
 it("keeps a live lease or queued job as conflict",async()=>{
   mocks.enqueue.mockResolvedValue({kind:'conflict'});
   expect(await retryProcessing(versionId)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 });
 it("hides a foreign version",async()=>{
   mocks.enqueue.mockResolvedValue({kind:'not_found'});
   expect(await retryProcessing(versionId)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 });
 it("validates before privileged work",async()=>{
   expect(await retryProcessing('invalid')).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
   expect(mocks.enqueue).not.toHaveBeenCalled();
 });
 it("confirmation returns its persisted receipt without any HTTP dispatch configuration",async()=>{
   vi.stubEnv('INGESTION_INTERNAL_TOKEN','');
   mocks.finalize.mockResolvedValue({versionId,uploadState:'confirmed'});
   expect(await finalizeUpload({versionId,attemptId:'50000000-0000-4000-8000-000000000010'})).toMatchObject({ok:true,data:{uploadState:'confirmed'}});
   expect(mocks.enqueue).not.toHaveBeenCalled();
   vi.unstubAllEnvs();
 });
});
