import { afterEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({init:vi.fn(),capture:vi.fn(),tags:vi.fn()}));
vi.mock('@sentry/node',()=>({init:mocks.init,withScope:(f:(scope:unknown)=>void)=>f({setTags:mocks.tags}),captureMessage:mocks.capture,flush:async()=>true}));
import { initWorkerTelemetry, reportWorkerFailure } from '@/modules/ingestion/worker/telemetry';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
it('installs a strict privacy boundary and drops automatic events',()=>{
 vi.stubEnv('INGESTION_ENVIRONMENT','development');vi.stubEnv('INGESTION_RELEASE_SHA','0'.repeat(40));
 initWorkerTelemetry();const options=mocks.init.mock.calls[0][0];
 expect(options.defaultIntegrations).toBe(false);expect(options.sendDefaultPii).toBe(false);
 expect(options.beforeSend({message:'private',exception:{values:[{value:'private'}]}})).toBeNull();
 reportWorkerFailure('30000000-0000-4000-8000-000000000010');
 const safe=options.beforeSend({tags:mocks.tags.mock.calls[0][0],request:{url:'signed?token=private'},extra:{document:'private'},message:'private'});
 expect(safe.tags.version_id).toBe('30000000-0000-4000-8000-000000000010');
 expect(JSON.stringify(safe)).not.toContain('private');
 expect(mocks.capture).toHaveBeenCalledWith('Product operation failed','error');
});
it('rejects invalid deployment telemetry configuration',()=>{
 vi.stubEnv('INGESTION_RELEASE_SHA','private-token');expect(()=>initWorkerTelemetry()).toThrow('Invalid worker telemetry configuration.');
});
