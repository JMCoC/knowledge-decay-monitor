import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { InternalFinding } from "../../../types/analysis-internal.ts";

// SQL parity: persist_analysis_batch must use the same ASCII class
// [ \t\n\r\f\v] for collapse and btrim, in the order collapse→trim.
const ASCII_WS = "[ \\t\\n\\r\\f\\v]";
const ASCII_WS_RUN = new RegExp(`${ASCII_WS}+`, "g");
const ASCII_WS_EDGES = new RegExp(`^${ASCII_WS}+|${ASCII_WS}+$`, "g");

export function normalizeEvidenceText(text: string): string {
  return text
    .normalize("NFC")
    .replace(ASCII_WS_RUN, " ")
    .replace(ASCII_WS_EDGES, "");
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

export function computeFindingFingerprint(finding: InternalFinding): string {
  const evidence = finding.evidence
    .map((entry) => ({
      versionId: entry.versionId,
      chunkId: entry.chunkId,
      snapshot: normalizeEvidenceText(entry.snapshot),
    }))
    .sort((left, right) => {
      if (left.versionId !== right.versionId) {
        return left.versionId < right.versionId ? -1 : 1;
      }
      if (left.chunkId !== right.chunkId) {
        return left.chunkId < right.chunkId ? -1 : 1;
      }
      return compareUtf8(left.snapshot, right.snapshot);
    });
  const versionIds = [
    ...new Set(finding.evidence.map((entry) => entry.versionId)),
  ].sort();
  const payload = canonicalJson({
    type: finding.type,
    versionIds,
    evidence,
  });
  return sha256Hex(payload);
}
