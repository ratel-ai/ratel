import type { IngestDelivery, IngestHandler, IngestResult } from "@/lib/contracts/ingest-queue";
import { decodeEnvelope, type Envelope, EnvelopeError } from "@/lib/ingest/queue/envelope";

/** What every driver does with a failed delivery (ADR-0010). Tests shorten the waits. */
export interface RetryPolicy {
  /** The wait after each failed delivery; one more failure than waits is a dead letter. */
  waitsMs: readonly number[];
  /** The wait after an outage, doubled from the first value up to the second. */
  outageWaitMs: { first: number; max: number };
}

export const RETRY_POLICY: RetryPolicy = {
  waitsMs: [1_000, 5_000, 30_000, 120_000],
  outageWaitMs: { first: 1_000, max: 30_000 },
};

export const maxDeliveries = (policy: RetryPolicy): number => policy.waitsMs.length + 1;

/** What the driver does next. */
export type Settlement =
  | { action: "ack" }
  | { action: "redeliver"; waitMs: number; outage: boolean; reason: string }
  | { action: "dead-letter"; reason: string };

export function settle(
  result: IngestResult,
  { attempt, outages }: { attempt: number; outages: number },
  policy: RetryPolicy,
): Settlement {
  switch (result.outcome) {
    case "ack":
      return { action: "ack" };
    case "dead-letter":
      return { action: "dead-letter", reason: boundedReason(result.reason) };
    case "outage":
      return {
        action: "redeliver",
        waitMs: outageWait(outages, policy),
        outage: true,
        reason: boundedReason(result.reason),
      };
    case "retry": {
      const reason = boundedReason(result.reason);
      const waitMs = policy.waitsMs[attempt - 1];
      return waitMs === undefined
        ? { action: "dead-letter", reason }
        : { action: "redeliver", waitMs, outage: false, reason };
    }
  }
}

/** A frame's envelope, or the result of a delivery that cannot read it. */
export function readFrame(
  frame: Uint8Array,
): { ok: true; envelope: Envelope } | { ok: false; result: IngestResult } {
  try {
    return { ok: true, envelope: decodeEnvelope(frame) };
  } catch (error) {
    if (!(error instanceof EnvelopeError)) throw error;
    return { ok: false, result: { outcome: "dead-letter", reason: error.message } };
  }
}

/** The result of a handler that may throw: an uncaught error is a retry. */
export async function runHandler<Message>(
  handler: IngestHandler<Message>,
  message: Message,
  delivery: IngestDelivery,
): Promise<IngestResult> {
  try {
    return await handler(message, delivery);
  } catch (error) {
    return { outcome: "retry", reason: errorReason(error) };
  }
}

/**
 * An error's kind. Never its message: a database error quotes the statement and its parameters,
 * and a parser quotes its input.
 */
export function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return "uncaught error";
  const code = errorCode(error);
  return code ? `uncaught ${error.name} (${code})` : `uncaught ${error.name}`;
}

/** The driver code of an error or of its cause (`ECONNREFUSED`, `57P01`). */
export function errorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const { code } = current as { code?: unknown };
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

function outageWait(outages: number, { outageWaitMs: { first, max } }: RetryPolicy): number {
  return Math.min(max, first * 2 ** Math.min(outages, 16));
}

const MAX_REASON_LENGTH = 500;

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_REASON_LENGTH);
}
