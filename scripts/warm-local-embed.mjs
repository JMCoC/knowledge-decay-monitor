import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const apiUrl = "http://127.0.0.1:54321";
const status = JSON.parse(execFileSync(process.execPath, [
  resolve("node_modules/supabase/dist/supabase.js"), "status", "-o", "json",
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

if (status.API_URL !== apiUrl || !status.SERVICE_ROLE_KEY) {
  throw new Error("Expected the local Supabase service for embedding warm-up.");
}

const headers = {
  apikey: status.SERVICE_ROLE_KEY,
  Authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
  "content-type": "application/json",
};
const url = `${apiUrl}/functions/v1/embed`;
const deadline = Date.now() + 3 * 60_000;

async function request(inputs) {
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs }),
    signal: AbortSignal.timeout(60_000),
  });
}

let probe;
while (Date.now() < deadline) {
  try {
    probe = await request(["local E2E embedding warm-up"]);
    if (probe.ok) break;
  } catch {}
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 1500));
}

if (!probe?.ok) throw new Error("The local embed function did not become ready within three minutes.");
const body = await probe.json();
if (body.dims !== 384 || body.embeddings?.[0]?.length !== 384) {
  throw new Error("The local embed function returned an unexpected vector shape.");
}

const batch = await request(Array.from({ length: 8 }, (_, index) => `warm-up text ${index}`));
if (!batch.ok) throw new Error("The local embed function failed its batch warm-up.");
const batchBody = await batch.json();
if (batchBody.dims !== 384 || batchBody.embeddings?.length !== 8) {
  throw new Error("The local embed function returned an incomplete warm-up batch.");
}

console.log("Local embed function is ready for E2E processing.");
