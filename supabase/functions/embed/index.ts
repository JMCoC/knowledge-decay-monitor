// Deno Edge Runtime file. `Deno` and `Supabase.ai` are runtime globals
// (no npm install; no Vitest coverage). Verified in Task 7 via
// `supabase functions serve embed`. Deviates from the prompt's `serve`
// import on purpose: `Deno.serve` is the current canonical form and needs
// no remote import.

declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
};

declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run(text: string, options: { mean_pool: boolean; normalize: boolean }): Promise<number[]>;
    };
  };
};

const MODEL = "gte-small";
const MAX_INPUTS = 8;

function failure(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isValidInputs(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_INPUTS &&
    value.every((text) => typeof text === "string")
  );
}

// Session is created once per isolate so warm invocations reuse the loaded
// weights (Task 0 measured ~7.4 s cold, ~1.6 s per 8-text batch warm).
const session = new Supabase.ai.Session(MODEL);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return failure(405, "method not allowed");
  }
  let inputs: unknown;
  try {
    const parsed: unknown = await req.json();
    inputs =
      typeof parsed === "object" && parsed !== null && "inputs" in parsed
        ? (parsed as { inputs: unknown }).inputs
        : undefined;
  } catch {
    return failure(400, "invalid inputs");
  }
  if (!isValidInputs(inputs)) {
    return failure(400, "invalid inputs");
  }

  // Never log inputs: embedding content is already-authorized document text.
  const embeddings = await Promise.all(
    inputs.map((text) => session.run(text, { mean_pool: true, normalize: true })),
  );
  const dims = embeddings[0]?.length ?? 0;
  if (dims === 0 || embeddings.some((vector) => vector.length !== dims)) {
    return failure(502, "embedding failed");
  }
  return new Response(JSON.stringify({ embeddings, dims }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
