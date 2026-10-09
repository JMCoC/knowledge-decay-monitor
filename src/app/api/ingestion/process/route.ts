/** Retired HTTP execution endpoint. Accepted uploads are processed by the durable worker. */
export async function POST(): Promise<Response> {
  return Response.json({ error: "Processing is handled by the ingestion worker." }, { status: 410 });
}
