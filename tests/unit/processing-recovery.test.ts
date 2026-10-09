import { describe, expect, it } from "vitest";
import type { RepositoryItem } from "@/types/contracts";
import { processingRecoveryAction } from "@/modules/repository/ui/processing-recovery";

type LatestVersion = NonNullable<RepositoryItem["latestVersion"]>;

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

function version(overrides: Partial<LatestVersion> = {}): LatestVersion {
  return {
    id: "30000000-0000-4000-8000-000000000010",
    version_number: 1,
    processing_status: "uploaded",
    version_status: null,
    analysis_status: null,
    uploadState: "confirmed",
    canOpen: true,
    processingStartedAt: null,
    ...overrides,
  };
}

describe("processingRecoveryAction", () => {
  it("offers Start only for a confirmed, unactivated uploaded v1", () => {
    expect(processingRecoveryAction(version(), NOW)).toBe("start");
    expect(processingRecoveryAction(version({ version_number: 2 }), NOW)).toBeNull();
    expect(processingRecoveryAction(version({ uploadState: "pending" }), NOW)).toBeNull();
    expect(processingRecoveryAction(version({ version_status: "active" }), NOW)).toBeNull();
  });

  it("offers Retry for a confirmed, unactivated processing failure", () => {
    expect(processingRecoveryAction(version({ processing_status: "processing_failed" }), NOW)).toBe("retry");
  });

  it("offers Retry only after the processing lease expires", () => {
    expect(processingRecoveryAction(version({
      processing_status: "processing",
      processingStartedAt: new Date(NOW - 180_001).toISOString(),
    }), NOW)).toBe("retry");
    expect(processingRecoveryAction(version({
      processing_status: "processing",
      processingStartedAt: new Date(NOW - 180_000).toISOString(),
    }), NOW)).toBeNull();
  });

  it.each([null, "not-a-timestamp", new Date(NOW + 1).toISOString()])(
    "does not offer Retry for an unknown or unexpired lease timestamp (%s)",
    (processingStartedAt) => {
      expect(processingRecoveryAction(version({
        processing_status: "processing",
        processingStartedAt,
      }), NOW)).toBeNull();
    },
  );

  it("does not offer recovery for ready versions or unconfirmed uploads", () => {
    expect(processingRecoveryAction(version({
      processing_status: "ready",
      version_status: "active",
    }), NOW)).toBeNull();
    expect(processingRecoveryAction(version({ uploadState: "verifying" }), NOW)).toBeNull();
  });
});
