import { describe, expect, it } from "vitest";
import { redactCliOutput } from "../../scripts/cli-output-redaction.mjs";

describe("CLI output redaction", () => {
  it("masks JWTs, Supabase keys, URL credentials, and named secrets", () => {
    const output = [
      "anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature-part",
      "service_role key: eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.other-signature",
      "publishable: sb_publishable_ABCDEF1234567890",
      "secret: sb_secret_ABCDEF1234567890",
      "DB URL: postgresql://postgres:supersecret@127.0.0.1:54322/postgres",
      "JWT secret: LOCAL_JWT_SENTINEL",
      "SERVICE_ROLE_KEY = SERVICE_SENTINEL",
    ].join("\n");

    const redacted = redactCliOutput(output);

    expect(redacted).not.toContain("signature-part");
    expect(redacted).not.toContain("other-signature");
    expect(redacted).not.toContain("sb_publishable_ABCDEF1234567890");
    expect(redacted).not.toContain("sb_secret_ABCDEF1234567890");
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("LOCAL_JWT_SENTINEL");
    expect(redacted).not.toContain("SERVICE_SENTINEL");
    expect(redacted).toContain("[redacted]");
  });

  it("keeps the diagnostic text that explains a failure", () => {
    const output =
      "failed to start container supabase_logflare_knowledge-decay-monitor-s1-02: container is unhealthy";
    expect(redactCliOutput(output)).toBe(output);
  });

  it("strips ANSI escape sequences", () => {
    expect(redactCliOutput("\u001b[31mError\u001b[0m: boom")).toBe("Error: boom");
  });

  it("keeps only the trailing lines within the line bound", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line-${index}`);
    const redacted = redactCliOutput(lines.join("\n"), { maxLines: 5 });
    expect(redacted.split("\n")).toEqual(["line-55", "line-56", "line-57", "line-58", "line-59"]);
  });

  it("keeps the trailing characters within the character bound", () => {
    const redacted = redactCliOutput(`HEAD${"x".repeat(5000)}TAIL`, { maxChars: 100 });
    expect(redacted.length).toBeLessThanOrEqual(100);
    expect(redacted.endsWith("TAIL")).toBe(true);
    expect(redacted).not.toContain("HEAD");
  });
});
