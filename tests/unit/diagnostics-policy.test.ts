import { describe, expect, it } from "vitest";
import {
  canRunDiagnostics,
  isDiagnosticExpiryActive,
} from "../../src/lib/observability/diagnostics-policy";

const admin = {
  userId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000001",
  role: "Admin",
} as const;
const policy = {
  enabled: true,
  operatorIds: [admin.userId],
  expiresAt: "2026-10-04T18:00:00Z",
} as const;
const beforeExpiry = Date.parse("2026-10-04T17:59:59Z");

describe("diagnostics authorization policy", () => {
  it("allows an allowlisted persisted Admin before the UTC expiry", () => {
    expect(canRunDiagnostics(admin, policy, Date.parse("2026-10-04T17:59:59Z"))).toBe(true);
  });

  it("denies at the exact expiry instant", () => {
    expect(canRunDiagnostics(admin, policy, Date.parse(policy.expiresAt))).toBe(false);
  });

  it("requires the persisted Admin role and an allowlisted user id", () => {
    expect(canRunDiagnostics({ ...admin, role: "Member" }, policy, beforeExpiry)).toBe(false);
    expect(
      canRunDiagnostics(
        { ...admin, userId: "10000000-0000-4000-8000-000000000002" },
        policy,
        beforeExpiry,
      ),
    ).toBe(false);
  });

  it.each([
    ["disabled", { ...policy, enabled: false }],
    ["missing operator", { ...policy, operatorIds: [] }],
    ["invalid operator", { ...policy, operatorIds: ["not-a-uuid"] }],
    ["missing expiry", { ...policy, expiresAt: "" }],
    ["expiry without timezone", { ...policy, expiresAt: "2026-10-04T18:00:00" }],
    ["impossible UTC date", { ...policy, expiresAt: "2026-02-31T18:00:00Z" }],
    ["expiry beyond the operational window", { ...policy, expiresAt: "2026-10-04T19:00:00Z" }],
  ])("fails closed for %s configuration", (_label, invalidPolicy) => {
    expect(canRunDiagnostics(admin, invalidPolicy, beforeExpiry)).toBe(false);
  });

  it("fails closed for an invalid clock value or actor id", () => {
    expect(canRunDiagnostics(admin, policy, Number.NaN)).toBe(false);
    expect(canRunDiagnostics({ ...admin, userId: "invalid" }, policy, beforeExpiry)).toBe(false);
  });

  it("lets the browser reject a diagnostic click after the render-time expiry", () => {
    expect(isDiagnosticExpiryActive(policy.expiresAt, Date.parse("2026-10-04T17:59:59Z"))).toBe(true);
    expect(isDiagnosticExpiryActive(policy.expiresAt, Date.parse(policy.expiresAt))).toBe(false);
  });
});
