const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAnalysisContinuation(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return null;
  return value;
}

export function analysisContinuationPath(analysisId: string | null): string | null {
  if (analysisId === null || !UUID_PATTERN.test(analysisId)) return null;
  return `/analysis/${analysisId}`;
}
