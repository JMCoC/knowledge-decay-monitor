import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hosted recovery email template", () => {
  it("uses the request redirect and carries the recovery token hash", () => {
    const template = readFileSync(resolve(process.cwd(), "supabase/templates/recovery.html"), "utf8");

    expect(template).toContain("{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=recovery");
    expect(template).not.toContain("{{ .SiteURL }}");
  });
});
