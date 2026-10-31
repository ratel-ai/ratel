import { getLogger } from "@/lib/platform/logger";
import { v1EndpointRemovedResponse } from "@/lib/platform/v1-errors";

/** The day intent extraction left the product, quoted in every 410 it leaves behind. */
export const INTENT_EXTRACTION_REMOVED_ON = "2026-10-15";

const logger = getLogger("http/gone");

/**
 * The handler behind a retired `/api/v1` prefix: every method on every path answers
 * 410 Gone in the v1 error envelope, so a client still calling it fails with a stable
 * `endpoint_removed` code instead of a 404 that reads like a typo.
 *
 * Unauthenticated on purpose. There is nothing behind it to protect, and checking the
 * key first would turn a clear answer into a 401 for anyone whose key has lapsed.
 */
export function removedEndpoint(removedOn: string) {
  return async function handleRemovedEndpoint(req: Request): Promise<Response> {
    logger.warn(
      { method: req.method, path: new URL(req.url).pathname, removed_on: removedOn },
      "removed api called",
    );
    return v1EndpointRemovedResponse(`This endpoint was removed on ${removedOn}.`);
  };
}
