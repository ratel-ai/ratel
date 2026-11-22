/**
 * LISTEN/NOTIFY channel names and payloads. NOTIFY is only a wake-up: a payload
 * carries a pointer (a seq), never data, and stays far under Postgres' 8,000-byte
 * cap. A reader always reads the rows from the tables after it wakes up.
 */

/** A gateway ID is part of a channel name, so it stays a plain lowercase identifier. */
export const GATEWAY_ID_PATTERN = /^[a-z0-9_]{1,40}$/;

const MAX_NOTIFY_PAYLOAD_BYTES = 8_000;

/** The channel a gateway listens on for its commands. */
export function gatewayChannel(gatewayId: string): string {
  if (!GATEWAY_ID_PATTERN.test(gatewayId)) throw new Error(`invalid gateway id: ${gatewayId}`);
  return `sandbox_gw_${gatewayId}`;
}

/** The channel a run's readers (SSE streams) listen on. Hyphens go so LISTEN needs no quoting. */
export function runChannel(runId: string): string {
  const compact = runId.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error(`invalid run id: ${runId}`);
  return `sandbox_run_${compact}`;
}

/** The NOTIFY payload of a run channel: the highest stored seq, nothing else. */
export function runNotifyPayload(seq: number): string {
  return notifyPayload({ seq });
}

/** The NOTIFY payload of a gateway channel: which run has a new command. */
export function gatewayNotifyPayload(runId: string): string {
  return notifyPayload({ runId });
}

/** Parses a run channel payload; a payload that is not one gives null (the reader re-reads anyway). */
export function parseRunNotifyPayload(payload: string | undefined): number | null {
  try {
    const seq = (JSON.parse(payload ?? "") as { seq?: unknown }).seq;
    return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null;
  } catch {
    return null;
  }
}

function notifyPayload(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") >= MAX_NOTIFY_PAYLOAD_BYTES)
    throw new Error("notify payload too large");
  return text;
}
