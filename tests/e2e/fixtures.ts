import { test as base } from "@playwright/test";
import { createTestWorker } from "../support/ingestion-worker";
export { expect } from "@playwright/test";
export type { BrowserContext, Page, Request } from "@playwright/test";

export const test=base.extend<object,{ingestionWorker:Awaited<ReturnType<typeof createTestWorker>>}>({
  ingestionWorker:[async({},provideWorker)=>{
    const worker=await createTestWorker();
    await worker.start();
    try { await provideWorker(worker); }
    finally { await worker.stop(); }
  },{scope:"worker",auto:true}],
});
