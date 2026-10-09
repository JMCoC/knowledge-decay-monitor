import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { assertLocalSupabaseReady } from "../support/local-supabase";
import { createProcessingFixture } from "../support/processing-fixtures";

beforeAll(assertLocalSupabaseReady);

it("the final image runs as node, loads offline and processes a local original", async () => {
  const image = process.env.KDM_WORKER_IMAGE;
  if (!image || !/^[a-z0-9][a-z0-9._:/-]+$/i.test(image)) throw new Error("KDM_WORKER_IMAGE is required.");
  const configured = JSON.parse(execFileSync("docker", ["image", "inspect", "--format", "{{json .Config}}", image],
    { encoding:"utf8", windowsHide:true, stdio:["ignore","pipe","pipe"] }));
  expect(configured.User).toBe("node");
  expect(configured.Env).toContain("INGESTION_MODEL_OFFLINE=1");
  const project = readFileSync("supabase/config.toml","utf8").match(/^project_id\s*=\s*"([a-z0-9_-]+)"/im)?.[1];
  if (!project) throw new Error("Local Supabase project ID unavailable.");
  const gateway = `supabase_kong_${project}`;
  expect(execFileSync("docker", ["inspect","--format","{{.State.Running}}",gateway],
    { encoding:"utf8", windowsHide:true, stdio:["ignore","pipe","pipe"] }).trim()).toBe("true");
  const fixture = await createProcessingFixture({ status:"processing", startedAt:new Date(Date.now()-181_000).toISOString() });
  const name = `kdm-ingestion-smoke-${randomUUID()}`;
  // Forward the key by environment name; it never appears in command arguments or logs.
  // Share only the local gateway network namespace; HTTP remains strictly loopback.
  const child = spawn("docker", ["run","--rm","--name",name,"--network",`container:${gateway}`,
    "-e","SUPABASE_URL=http://127.0.0.1:8000",
    "-e","SUPABASE_SERVICE_ROLE_KEY","-e","KDM_DISABLE_SENTRY=1",image],
    { env:process.env, stdio:"ignore", windowsHide:true });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return "exited";
      try {
        return execFileSync("docker",["exec",name,"node","-e",
          "fetch('http://127.0.0.1:8788/health').then(async r=>console.log(r.ok?(await r.json()).status:'unavailable')).catch(()=>console.log('starting'))"],
          { encoding:"utf8", windowsHide:true, stdio:["ignore","pipe","pipe"], timeout:3_000 }).trim();
      } catch { return "starting"; }
    }, { timeout:90_000 }).toBe("ready");
    await expect.poll(async () => {
      const result = await fixture.service.from("document_versions").select("processing_status,version_status").eq("id",fixture.versionId).single();
      return result.data;
    }, { timeout:30_000 }).toEqual({ processing_status:"ready", version_status:"active" });
    const chunks = await fixture.service.from("document_chunks").select("embedding").eq("version_id",fixture.versionId);
    expect(chunks.error).toBeNull();
    expect(chunks.data).toHaveLength(1);
    const vector = JSON.parse(chunks.data![0].embedding) as number[];
    expect(vector).toHaveLength(384);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(Math.sqrt(vector.reduce((sum,n) => sum+n*n,0))).toBeCloseTo(1,4);
    const doc = await fixture.service.from("documents").select("active_version_id").eq("id",fixture.documentId).single();
    expect(doc.data?.active_version_id).toBe(fixture.versionId);
  } finally {
    try {
      try { execFileSync("docker", ["stop","--time","10",name], { windowsHide:true, stdio:"ignore", timeout:20_000 }); }
      catch { execFileSync("docker", ["rm","--force",name], { windowsHide:true, stdio:"ignore", timeout:20_000 }); }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve,5_000))]);
    } finally { await fixture.dispose(); }
  }
});
