export type OtlpTransport = "json" | "protobuf";

/**
 * Build the successful response for either OTLP signal.
 *
 * A protobuf request gets the zero-byte wire encoding of a full-success
 * Export<signal>ServiceResponse; JSON callers keep their existing envelope. Count
 * headers are additive and shared by both transports. HTTP 200 and encoded error
 * responses remain a separate compatibility migration.
 */
export function otlpSuccessResponse(
  transport: OtlpTransport,
  counts: Readonly<Record<string, number>>,
): Response {
  const headers = countHeaders(counts);
  if (transport === "protobuf") {
    return new Response(new Uint8Array(0), {
      status: 202,
      headers: { ...headers, "content-type": "application/x-protobuf" },
    });
  }
  return Response.json(counts, { status: 202, headers });
}

/** Pick the decode path; null means an unsupported content-type (→ 415). */
export function transportFor(contentType: string): OtlpTransport | null {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("application/json")) return "json";
  // The OTLP SDK exporter sends x-protobuf; treat a missing type as protobuf too.
  if (
    normalized.includes("protobuf") ||
    normalized.includes("application/octet-stream") ||
    normalized.trim() === ""
  ) {
    return "protobuf";
  }
  return null;
}

function countHeaders(counts: Readonly<Record<string, number>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(counts).map(([name, count]) => [`x-ratel-${name}`, String(count)]),
  );
}
