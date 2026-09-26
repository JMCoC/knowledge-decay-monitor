// Integration smoke test against this project's disposable LOCAL Supabase only.
// Does not print status output, keys, JWTs, signed URLs, or document contents.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const base = "http://127.0.0.1:54321";
const paths = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001/original.md",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/20000000-0000-4000-8000-000000000004/30000000-0000-4000-8000-000000000004/original.md",
};

async function run() {
  let status;
  try {
    status = JSON.parse(execFileSync(process.execPath, [
      resolve("node_modules/supabase/dist/supabase.js"), "status", "-o", "json",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    throw new Error("Local Supabase status unavailable. Start the stack from the project root.");
  }
  assert.equal(status.API_URL, base, "This test only targets the configured local API");
  const apiKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  assert.ok(apiKey, "Local publishable/anon key is required");

  async function request(path, token, options = {}) {
    return fetch(`${base}${path}`, {
      ...options,
      headers: {
        apikey: apiKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(15000),
    });
  }

  const users = [
    ["admin.a@example.test", 3],
    ["qa.a@example.test", 3],
    ["member.a@example.test", 0],
    ["admin.b@example.test", 1],
  ];
  const tokens = [];
  for (const [email, expectedDocuments] of users) {
    const login = await request("/auth/v1/token?grant_type=password", null, {
      method: "POST",
      body: JSON.stringify({ email, password: "LocalOnly-KDM-2026!" }),
    });
    assert.equal(login.status, 200, `Fixture login failed for ${email}`);
    const { access_token: token } = await login.json();
    assert.ok(token, "Auth response must contain a session");
    tokens.push(token);
    const response = await request("/rest/v1/documents?select=id", token);
    assert.equal(response.status, 200, "Authenticated REST query failed");
    const documents = await response.json();
    assert.equal(documents.length, expectedDocuments, `Document isolation for ${email}`);
  }

  async function sign(token, path) {
    return request(`/storage/v1/object/sign/documents/${path}`, token, {
      method: "POST", body: JSON.stringify({ expiresIn: 300 }),
    });
  }

  for (const [token, path] of [[tokens[0], paths.a], [tokens[1], paths.a], [tokens[3], paths.b]]) {
    const response = await sign(token, path);
    assert.equal(response.status, 200, "Authorized original signing failed; run seed buckets --local");
    const { signedURL } = await response.json();
    assert.ok(signedURL, "Signing must return a URL");
    const url = new URL(`/storage/v1${signedURL}`, base);
    assert.equal(url.origin, base, "Signed fixture must remain local");
    const original = await fetch(url, { signal: AbortSignal.timeout(15000) });
    assert.equal(original.status, 200, "Signed original must be downloadable");
    assert.ok((await original.text()).startsWith("# "), "Expected real Markdown fixture");
  }
  for (const [token, path] of [[tokens[0], paths.b], [tokens[3], paths.a], [tokens[2], paths.a]]) {
    const response = await sign(token, path);
    assert.ok(!response.ok, "Cross-tenant/Member signed URL must be denied");
  }
  const publicFile = await fetch(`${base}/storage/v1/object/public/documents/${paths.a}`, {
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(!publicFile.ok, "Private bucket must not expose public originals");
  console.log("PASS: 4 Auth logins, REST isolation, 3 signed downloads, 3 signing denials, private bucket.");
}

run().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
