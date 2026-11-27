import type { IngestResult } from "@/lib/contracts/ingest-queue";
import { errorReason } from "./settle";

/** Postgres classes and codes of a server that cannot be reached or refuses all work. */
const OUTAGE_CLASSES = new Set([
  "08", // connection exception
  "53", // insufficient resources: connections, disk, memory
]);
const OUTAGE_CODES = new Set([
  "57P01", // admin shutdown
  "57P02", // crash shutdown
  "57P03", // cannot connect now
  "25006", // read only: the server is now a replica
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
/** What `pg` says of its own connections, without a code. */
const OUTAGE_MESSAGES =
  /^(Connection terminated|timeout exceeded when trying to connect|timeout expired|Client has encountered a connection error)/;
const MAX_CAUSES = 5;

/** How a delivery ends whose write failed: the store is down, or this message failed. */
export function storeFailure(error: unknown): IngestResult {
  return { outcome: isOutage(error) ? "outage" : "retry", reason: errorReason(error) };
}

export function isOutage(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < MAX_CAUSES; depth++) {
    if (!(current instanceof Error)) return false;
    const { code } = current as { code?: unknown };
    if (typeof code === "string") {
      if (OUTAGE_CODES.has(code)) return true;
      if (/^[0-9A-Z]{5}$/.test(code) && OUTAGE_CLASSES.has(code.slice(0, 2))) return true;
    }
    if (OUTAGE_MESSAGES.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
