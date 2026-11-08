import { z } from "zod";

const MAX_CODE_POINTS = 2000;

const boundedText = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "text must not be blank",
  })
  .refine((value) => Array.from(value).length <= MAX_CODE_POINTS, {
    message: `text must not exceed ${MAX_CODE_POINTS} code points`,
  });

const evidenceSchema = z
  .object({
    side: z.enum(["source", "comparison"]),
    quote: boundedText,
  })
  .strict();

const evidencePairSchema = z
  .array(evidenceSchema)
  .length(2)
  .refine(
    (evidence) =>
      evidence.filter((entry) => entry.side === "source").length === 1 &&
      evidence.filter((entry) => entry.side === "comparison").length === 1,
    { message: "evidence must contain exactly one source and one comparison" },
  );

const findingSchema = z
  .object({
    type: z.enum(["contradiction", "obsolescence"]),
    severity: z.enum(["High", "Medium", "Low"]),
    confidence: z.number().min(0).max(1),
    explanation: boundedText,
    evidence: evidencePairSchema,
  })
  .strict();

export type WireEvidence = {
  side: "source" | "comparison";
  quote: string;
};

export type WireFinding = {
  type: "contradiction" | "obsolescence";
  severity: "High" | "Medium" | "Low";
  confidence: number;
  explanation: string;
  evidence: [WireEvidence, WireEvidence];
};

const wireSchemaObject = z
  .object({
    findings: z.array(findingSchema).max(20),
  })
  .strict();

export const wireSchema = wireSchemaObject as unknown as z.ZodType<{
  findings: WireFinding[];
}>;

export const WIRE_JSON_SCHEMA = z.toJSONSchema(wireSchema) as Record<
  string,
  unknown
>;
