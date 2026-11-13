"use server";

import { revalidatePath } from "next/cache";
import { findProjectScope, requireProjectScope } from "@/lib/console/scope/project-scope";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getSessionContext } from "@/lib/platform/session";
import { reportServerException, trackServerEvent } from "@/lib/platform/telemetry";
import { enqueueAssignTopicsJob, loadTopicReading } from "@/lib/readings/topics/queries";
import type { IntentAsksTree } from "@/lib/views/intents/asks-tree";
import type { IntentBreakdown, IntentBreakdownSummary } from "@/lib/views/intents/breakdown";
import {
  loadIntentAsksTrees,
  loadIntentBreakdown,
  loadIntentBreakdownSummary,
} from "@/lib/views/intents/breakdown-queries";
import {
  type ExampleAsk,
  type ExampleTarget,
  exampleTurnIds,
  leadTurnIds,
  loadExampleAsks,
  pickLeads,
} from "@/lib/views/intents/topics-examples";
import { type IntentStepsRead, loadIntentSteps } from "@/lib/views/intents/topics-steps-load";

/**
 * The server calls the Intents pages make. Each re-resolves the session and
 * the project scope server-side and trusts nothing the client sends but ids;
 * a read for a project the user can't see answers "not found" quietly (a
 * stale tab is not an error worth a report).
 * Example asks are captured content: read on demand (when a panel opens, or
 * once the list is on screen for each intent's one example), for the turns
 * the stored reading names, and never logged. So are the names of what an
 * intent's asks are for and the ways people ask it: they are read from the
 * asks, so they come with the panel or the row that shows them.
 *
 * Owned (ADR-0030): the project comes from the console scope and the actor is
 * the session user.
 */

const logger = getLogger("topics/actions");

const NOT_FOUND = { ok: false, message: "Not found." } as const;

export type ExamplesResult = { ok: true; examples: ExampleAsk[] } | { ok: false; message: string };

export async function loadTopicExamplesAction(
  projectId: string,
  target: ExampleTarget,
): Promise<ExamplesResult> {
  if (!isDbConfigured()) return { ok: false, message: "No database connected." };
  if (!(await getSessionContext())) return { ok: false, message: "Not signed in." };
  try {
    const scope = await findProjectScope(projectId);
    if (!scope) return NOT_FOUND;
    const reading = await loadTopicReading(scope.project.id);
    if (!reading) return { ok: true, examples: [] };
    const ids = exampleTurnIds(reading.insights, target);
    return { ok: true, examples: await loadExampleAsks(scope.project.id, ids) };
  } catch (error) {
    logger.error({ err: error, project_id: projectId }, "topic examples read failed");
    reportServerException(error, `project:${projectId}`, { operation: "topic_examples" });
    return { ok: false, message: "Couldn't load the example asks. Try again in a moment." };
  }
}

export type LeadsResult =
  | { ok: true; leads: Record<string, ExampleAsk> }
  | { ok: false; message: string };

/** One example ask per intent, by intent id: the second line of each row on All intents. */
export async function loadIntentLeadsAction(projectId: string): Promise<LeadsResult> {
  if (!isDbConfigured()) return { ok: false, message: "No database connected." };
  if (!(await getSessionContext())) return { ok: false, message: "Not signed in." };
  try {
    const scope = await findProjectScope(projectId);
    if (!scope) return NOT_FOUND;
    const reading = await loadTopicReading(scope.project.id);
    if (!reading) return { ok: true, leads: {} };
    const candidates = leadTurnIds(reading.insights);
    const read = await loadExampleAsks(scope.project.id, [...candidates.values()].flat());
    return { ok: true, leads: pickLeads(candidates, read) };
  } catch (error) {
    logger.error({ err: error, project_id: projectId }, "intent lead examples read failed");
    reportServerException(error, `project:${projectId}`, { operation: "intent_lead_examples" });
    return { ok: false, message: "Couldn't load the example asks. Try again in a moment." };
  }
}

export type IntentDetailResult =
  | { ok: true; breakdown: IntentBreakdown | null; steps: IntentStepsRead }
  | { ok: false; message: string };

/** The longest id an intent can have; anything longer is not one. */
const TOPIC_ID_MAX = 128;

/**
 * An intent's panel, past what the page holds: what its asks are for and the
 * ways people ask it (with sample asks), what else the same ask wants, and
 * the steps it is done in. Read when the panel opens. Each part degrades to
 * nothing on its own (logged and reported where it is read), so a slow
 * engine read never hides the steps.
 */
export async function loadIntentDetailAction(
  projectId: string,
  topicId: string,
): Promise<IntentDetailResult> {
  if (typeof topicId !== "string" || topicId.length === 0 || topicId.length > TOPIC_ID_MAX) {
    return { ok: false, message: "Unknown intent." };
  }
  if (!isDbConfigured()) return { ok: false, message: "No database connected." };
  if (!(await getSessionContext())) return { ok: false, message: "Not signed in." };
  try {
    const scope = await findProjectScope(projectId);
    if (!scope) return NOT_FOUND;
    const [breakdown, steps] = await Promise.all([
      loadIntentBreakdown(scope.project.id, topicId),
      loadIntentSteps(scope.project.id, topicId),
    ]);
    return { ok: true, breakdown, steps };
  } catch (error) {
    logger.error({ err: error, project_id: projectId }, "intent detail read failed");
    reportServerException(error, `project:${projectId}`, { operation: "intent_detail" });
    return { ok: false, message: "Couldn't load this intent's detail. Try again in a moment." };
  }
}

export type IntentRowsResult =
  | { ok: true; rows: Record<string, IntentBreakdownSummary> }
  | { ok: false; message: string };

/** What each intent's asks are for, by intent id: the rows a chevron opens on All intents. */
export async function loadIntentRowsAction(projectId: string): Promise<IntentRowsResult> {
  if (!isDbConfigured()) return { ok: false, message: "No database connected." };
  if (!(await getSessionContext())) return { ok: false, message: "Not signed in." };
  try {
    const scope = await findProjectScope(projectId);
    if (!scope) return NOT_FOUND;
    return {
      ok: true,
      rows: Object.fromEntries(await loadIntentBreakdownSummary(scope.project.id)),
    };
  } catch (error) {
    logger.error({ err: error, project_id: projectId }, "intent rows read failed");
    reportServerException(error, `project:${projectId}`, { operation: "intent_rows" });
    return {
      ok: false,
      message: "Couldn't load what these intents' asks are for. Try again in a moment.",
    };
  }
}

export type IntentAsksResult =
  | { ok: true; trees: Record<string, IntentAsksTree> }
  | { ok: false; message: string };

/** Every intent's asks as a tree, by intent id: what the Asks lens on Intents › Map draws inside each intent, read when it opens. */
export async function loadIntentAsksAction(projectId: string): Promise<IntentAsksResult> {
  if (!isDbConfigured()) return { ok: false, message: "No database connected." };
  if (!(await getSessionContext())) return { ok: false, message: "Not signed in." };
  try {
    const scope = await findProjectScope(projectId);
    if (!scope) return NOT_FOUND;
    return { ok: true, trees: Object.fromEntries(await loadIntentAsksTrees(scope.project.id)) };
  } catch (error) {
    logger.error({ err: error, project_id: projectId }, "intent asks read failed");
    reportServerException(error, `project:${projectId}`, { operation: "intent_asks" });
    return {
      ok: false,
      message: "Couldn't read what these intents' asks are for. Try again in a moment.",
    };
  }
}

export type ReadingResult = { ok: true; coalesced: boolean } | { ok: false; message: string };

/** "Read now": queue a topic reading (coalesced with one already waiting) and drain after the response. */
export async function requestTopicReadingAction(projectId: string): Promise<ReadingResult> {
  if (!isDbConfigured()) return { ok: false, message: "No database connected." };
  if (!(await getSessionContext())) return { ok: false, message: "Not signed in." };
  const scope = await requireProjectScope(projectId);
  try {
    const queued = await enqueueAssignTopicsJob(scope.project.id);
    scheduleProjectDrain(scope.project.id);
    await trackServerEvent(
      "topic_run_requested",
      {
        externalId: scope.user.externalId,
        orgId: scope.organization.id,
        projectId: scope.project.id,
      },
      { object_action: "topic_run_requested", coalesced: queued === null },
    );
    const root = `/project/${scope.project.id}/intents`;
    for (const path of [root, `${root}/flows`, `${root}/map`]) revalidatePath(path);
    return { ok: true, coalesced: queued === null };
  } catch (error) {
    logger.error({ err: error, project_id: scope.project.id }, "topic reading enqueue failed");
    reportServerException(error, scope.user.externalId, {
      operation: "topic_reading_request",
      project_id: scope.project.id,
    });
    return { ok: false, message: "Couldn't start a reading. Try again in a moment." };
  }
}
