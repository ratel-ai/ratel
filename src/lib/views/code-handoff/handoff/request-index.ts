import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { getLogger } from "@/lib/platform/logger";
import { enqueueCodeIndex } from "./code-index";

/**
 * Ask for a code index run (RC-917) from a request: when a repo is linked,
 * and at handoff when the index is stale. It never fails the caller: the
 * index is garnish for the brief. Kept apart from `code-index.ts`, which the
 * job handlers import, so the drain scheduler does not form an import cycle.
 */

const logger = getLogger("code-handoff/request-index");

export async function requestCodeIndex(
  projectId: string,
  options: { staleAfterMs?: number } = {},
): Promise<void> {
  try {
    const outcome = await enqueueCodeIndex(projectId, options);
    if (outcome === "queued") scheduleProjectDrain(projectId);
    logger.info({ project_id: projectId, outcome }, "code index requested");
  } catch (error) {
    logger.warn({ project_id: projectId, err: error }, "code index request failed");
  }
}
