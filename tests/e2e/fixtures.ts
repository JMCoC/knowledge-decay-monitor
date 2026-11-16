import { test as base } from "@playwright/test";
import { createTestWorker } from "../support/ingestion-worker";
export { expect } from "@playwright/test";
export type { BrowserContext, Page, Request } from "@playwright/test";

export const test=base.extend<object,{ingestionWorker:Awaited<ReturnType<typeof createTestWorker>>}>({
  ingestionWorker:[async({},provideWorker)=>{
    // Review E2E owns an isolated Supabase stack on dynamically allocated ports
    // and does not exercise ingestion, so it must not start the shared local worker.
    const worker=process.env.KDM_LOCAL_SUPABASE_DISPOSABLE === "review"
      ? { start: async()=>{}, stop: async()=>{} }
      : await createTestWorker();
    await worker.start();
    try { await provideWorker(worker); }
    finally { await worker.stop(); }
  },{scope:"worker",auto:true}],
});
