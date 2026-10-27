import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { createBatchPersistence } from "../../src/modules/analysis/worker/batch-persistence";
import { createFinalization } from "../../src/modules/analysis/worker/finalization";
import { runAnalysisJob } from "../../src/modules/analysis/worker/process-analysis";
import type { AnalysisWorkerDb } from "../../src/modules/analysis/worker/types";
import type {
  AnalysisExecutionManifest,
  InternalFinding,
} from "../../src/types/analysis-internal";
import type { Database, Json } from "../../src/types/database";
import { FakeAnalysisProvider } from "../../supabase/functions/analyze/_test_doubles/analysis-provider.fake";
import {
  createAnalysisFixture,
  type AnalysisFixture,
} from "../support/analysis-fixtures";
import { assertLocalSupabaseReady } from "../support/local-supabase";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const WORKER_MANIFEST: AnalysisExecutionManifest = {
  fingerprintVersion: "s2-05-v2",
  pricingVersion: "s2-04-v1",
  promptVersion: "prompt-finalization-integration-v1",
  outputSchemaVersion: "schema-finalization-integration-v1",
  providers: {
    primary: { provider: "synthetic-test", model: "fake" },
    fallback: { provider: "synthetic-test", model: "fake" },
  },
};
const WORKER_MANIFEST_JSON = WORKER_MANIFEST as unknown as Json;

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || process.env.KDM_LOCAL_SUPABASE_URL !== LOCAL_API_URL) {
    throw new Error("Local Supabase service test configuration is missing.");
  }
  return createClient<Database>(LOCAL_API_URL, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

type Service = ReturnType<typeof serviceClient>;

interface PreparedFinalization {
  service: Service;
  fixture: AnalysisFixture;
  analysisId: string;
  sourceVersionId: string;
  comparisonVersionId: string;
  findings: InternalFinding[];
}

function evidenceFor(
  ref: { documentId: string; versionId: string; chunkId: string },
  role: "source" | "comparison",
  snapshot: string,
) {
  return {
    documentId: ref.documentId,
    versionId: ref.versionId,
    chunkId: ref.chunkId,
    role,
    snapshot,
    pageNumber: 1,
    section: "Finalization integration",
    sectionHeading: "Synthetic evidence",
  };
}

function buildFindings(
  fixture: AnalysisFixture,
): InternalFinding[] {
  const source = fixture.versions[0];
  const comparison = fixture.versions[1];
  if (!source || !comparison) {
    throw new Error("Finalization fixture did not create two versions.");
  }
  return [
    {
      type: "contradiction",
      severity: "High",
      confidence: 0.93,
      explanation: "The source contradicts the comparison.",
      evidence: [
        evidenceFor(source, "source", "Source evidence for contradiction."),
        evidenceFor(
          comparison,
          "comparison",
          "Comparison evidence for contradiction.",
        ),
      ],
    },
    {
      type: "obsolescence",
      severity: "Medium",
      confidence: 0.78,
      explanation: "The comparison is outdated.",
      evidence: [
        evidenceFor(source, "source", "Source evidence for obsolescence."),
        evidenceFor(
          comparison,
          "comparison",
          "Comparison evidence for obsolescence.",
        ),
      ],
    },
  ];
}

async function prepareAnalysis(
  service: Service,
  findings: boolean,
): Promise<PreparedFinalization> {
  const fixture = await createAnalysisFixture({
    versionCount: 2,
    status: "failed",
  });
  try {
    const sourceVersionId = fixture.versions[0]?.versionId;
    const comparisonVersionId = fixture.versions[1]?.versionId;
    if (!sourceVersionId || !comparisonVersionId) {
      throw new Error("Finalization fixture did not create two versions.");
    }

    const estimate = await service.rpc("create_analysis_estimate", {
      p_actor_id: fixture.adminId,
      p_source_version_ids: [sourceVersionId],
      p_comparison_version_ids: [comparisonVersionId],
      p_manifest: WORKER_MANIFEST_JSON,
    });
    expect(estimate.error).toBeNull();
    const estimateRef = estimate.data?.[0]?.estimate_ref;
    if (!estimateRef) {
      throw new Error("Finalization fixture estimate was not persisted.");
    }

    const created = await service.rpc("run_analysis", {
      p_actor_id: fixture.adminId,
      p_estimate_ref: estimateRef,
      p_idempotency_key: `finalization-integration-${randomUUID()}`,
      p_current_manifest: WORKER_MANIFEST_JSON,
    });
    expect(created.error).toBeNull();
    const analysisId = created.data?.[0]?.analysis_id;
    if (!analysisId) {
      throw new Error("Finalization fixture run was not persisted.");
    }

    return {
      service,
      fixture,
      analysisId,
      sourceVersionId,
      comparisonVersionId,
      findings: findings ? buildFindings(fixture) : [],
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function cleanup(prepared: PreparedFinalization) {
  try {
    await prepared.fixture.sql.query(
      `delete from private.analysis_finding_staging where analysis_id = '${prepared.analysisId}';`,
    );
    await prepared.fixture.sql.query(
      `delete from private.analysis_finding_evidence_staging where analysis_id = '${prepared.analysisId}';`,
    );
  } finally {
    await prepared.fixture.dispose();
  }
}

async function count(
  service: Service,
  table: "findings" | "finding_evidence" | "notification_events",
  analysisId: string,
) {
  const { count: value, error } = await service
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("analysis_id", analysisId);
  expect(error).toBeNull();
  return value ?? -1;
}

async function stagingCount(prepared: PreparedFinalization, table: string) {
  const result = await prepared.fixture.sql.query(
    `select count(*)::text from private.${table} where analysis_id = '${prepared.analysisId}';`,
  );
  return result.trim();
}

describe("S2-08a real analysis finalization", () => {
  beforeAll(async () => {
    await assertLocalSupabaseReady();
  });

  it("publishes findings and closes a successful run through the real factories", async () => {
    const service = serviceClient();
    const prepared = await prepareAnalysis(service, true);
    try {
      const client = service as unknown as AnalysisWorkerDb;
      const provider = new FakeAnalysisProvider({
        findings: prepared.findings,
      });
      const result = await runAnalysisJob({
        client,
        provider,
        persistence: createBatchPersistence(client),
        finalization: createFinalization(client),
        analysisId: prepared.analysisId,
      });

      expect(result).toEqual({
        kind: "completed",
        claimedId: prepared.analysisId,
      });

      const { data: analysis, error: analysisError } = await service
        .from("analyses")
        .select("status")
        .eq("id", prepared.analysisId)
        .single();
      expect(analysisError).toBeNull();
      expect(analysis?.status).toBe("completed");

      const { data: findings, error: findingsError } = await service
        .from("findings")
        .select("type,severity_current")
        .eq("analysis_id", prepared.analysisId)
        .order("type");
      expect(findingsError).toBeNull();
      expect(findings).toEqual([
        { type: "contradiction", severity_current: "High" },
        { type: "obsolescence", severity_current: "Medium" },
      ]);
      expect(
        await count(service, "finding_evidence", prepared.analysisId),
      ).toBe(4);

      const { data: ledger, error: ledgerError } = await service
        .from("credit_ledger")
        .select("event_type,amount")
        .eq("analysis_id", prepared.analysisId)
        // Tiebreaker: Reserved and Released/Consumed can share created_at
        // when the fixture inserts them in one transaction
        // (transaction_timestamp() is constant within a tx). Ascending
        // event_type follows the enum declaration order
        // (Promotional, Reserved, Consumed, Released), so Reserved precedes
        // both Released and Consumed. Promotional is not inserted for an
        // analysis. Revisit if the enum order changes in a future migration.
        .order("created_at")
        .order("event_type", { ascending: true });
      expect(ledgerError).toBeNull();
      expect(ledger?.map((row) => row.event_type)).toEqual([
        "Reserved",
        "Consumed",
      ]);

      const { data: events, error: eventsError } = await service
        .from("notification_events")
        .select("type")
        .eq("analysis_id", prepared.analysisId);
      expect(eventsError).toBeNull();
      expect(events).toEqual([{ type: "analysis_completed" }]);

      const { data: versions, error: versionsError } = await service
        .from("document_versions")
        .select("id,analysis_status")
        .in("id", [
          prepared.sourceVersionId,
          prepared.comparisonVersionId,
        ]);
      expect(versionsError).toBeNull();
      expect(
        versions?.find((version) => version.id === prepared.sourceVersionId)
          ?.analysis_status,
      ).toBe("analyzed");
      expect(
        versions?.find(
          (version) => version.id === prepared.comparisonVersionId,
        )?.analysis_status,
      ).toBe("pending_reanalysis");

      expect(
        await stagingCount(prepared, "analysis_finding_staging"),
      ).toBe("0");
      expect(
        await stagingCount(prepared, "analysis_finding_evidence_staging"),
      ).toBe("0");
    } finally {
      await cleanup(prepared);
    }
  }, 60_000);

  it("closes a zero-findings run with Consumed and the completion event", async () => {
    const service = serviceClient();
    const prepared = await prepareAnalysis(service, false);
    try {
      const client = service as unknown as AnalysisWorkerDb;
      const result = await runAnalysisJob({
        client,
        provider: new FakeAnalysisProvider(),
        persistence: createBatchPersistence(client),
        finalization: createFinalization(client),
        analysisId: prepared.analysisId,
      });

      expect(result).toEqual({
        kind: "completed",
        claimedId: prepared.analysisId,
      });
      expect(await count(service, "findings", prepared.analysisId)).toBe(0);
      expect(
        await count(service, "finding_evidence", prepared.analysisId),
      ).toBe(0);

      const { data: analysis, error: analysisError } = await service
        .from("analyses")
        .select("status")
        .eq("id", prepared.analysisId)
        .single();
      expect(analysisError).toBeNull();
      expect(analysis?.status).toBe("completed");

      const { data: ledger, error: ledgerError } = await service
        .from("credit_ledger")
        .select("event_type,amount")
        .eq("analysis_id", prepared.analysisId)
        // Tiebreaker: Reserved and Released/Consumed can share created_at
        // when the fixture inserts them in one transaction
        // (transaction_timestamp() is constant within a tx). Ascending
        // event_type follows the enum declaration order
        // (Promotional, Reserved, Consumed, Released), so Reserved precedes
        // both Released and Consumed. Promotional is not inserted for an
        // analysis. Revisit if the enum order changes in a future migration.
        .order("created_at")
        .order("event_type", { ascending: true });
      expect(ledgerError).toBeNull();
      expect(ledger?.map((row) => row.event_type)).toEqual([
        "Reserved",
        "Consumed",
      ]);

      const { data: events, error: eventsError } = await service
        .from("notification_events")
        .select("type")
        .eq("analysis_id", prepared.analysisId);
      expect(eventsError).toBeNull();
      expect(events).toEqual([{ type: "analysis_completed" }]);

      expect(
        await stagingCount(prepared, "analysis_finding_staging"),
      ).toBe("0");
      expect(
        await stagingCount(prepared, "analysis_finding_evidence_staging"),
      ).toBe("0");
    } finally {
      await cleanup(prepared);
    }
  }, 60_000);
});
