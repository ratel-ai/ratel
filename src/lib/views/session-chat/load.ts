import { and, eq, inArray } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import { loadSessionLens } from "@/lib/views/session-replay/annotations-load";
import { loadSessionReplay, type ReplayDb } from "@/lib/views/session-replay/load";
import type { SessionTimeline } from "@/lib/views/session-replay/timeline";
import { chipText } from "@/lib/views/session-replay/view";
import { forkTargets } from "@/lib/views/session-replay/what-if";
import { loadSessionSegments } from "@/lib/views/tasks/session-segments";
import {
  buildSessionChat,
  type ChatCallText,
  chatBands,
  type SessionChat,
  type TurnIntent,
} from "./model";
import { chatTextOf } from "./text";

/**
 * Reads one session for the chat replay (RC-281): the RC-144 timeline and its
 * turns, plus, only when the project's content opt-in is on, the full ask and
 * reply text of each model call. Off, no payload is read and the chat keeps
 * its shape with no words.
 */

const ID_CHUNK = 500;
const logger = getLogger("session-chat");

export interface SessionChatOptions {
  /** The project's content opt-in (`session_replay_settings.read_content`). */
  readContent: boolean;
}

const SENTIMENTS: ReadonlySet<string> = new Set(["positive", "neutral", "negative"]);

/** The session as a chat, with its typed steps, task bands and each turn's intent; null when the project has no closed turn in it. */
export async function loadSessionChat(
  projectId: string,
  sessionId: string,
  { readContent }: SessionChatOptions,
  db: ReplayDb = getDb(),
): Promise<SessionChat | null> {
  const replay = await loadSessionReplay(projectId, sessionId, db);
  if (!replay) return null;
  const callIds = replay.timeline.steps.flatMap((step) =>
    step.kind === "model_call" ? [step.eventId] : [],
  );
  // One after the other: the page reads on a single connection.
  const texts = readContent ? await loadChatTexts(projectId, callIds, db) : null;
  const lens = await loadSessionLens(projectId, replay.timeline, db);
  const chat = buildSessionChat({ ...replay, texts });
  chat.bands = await loadBands(projectId, sessionId, chat, replay.timeline, db);
  chat.intents = await loadIntents(projectId, chat, db);
  // The context split of each call: counts only, the same lens as the step-by-step view.
  chat.splits = Object.fromEntries(
    lens.calls.map((call) => [
      call.step,
      { inputTokens: call.composition.inputTokens, parts: call.composition.parts },
    ]),
  );
  // RC-524: what the step-by-step view offered, for the inspector.
  chat.forks = forkTargets(replay.timeline);
  chat.verdicts = {};
  for (const annotation of lens.annotations)
    (chat.verdicts[annotation.step] ??= []).push({
      tone: annotation.verdict,
      text: chipText(annotation),
    });
  logger.info(
    {
      project_id: projectId,
      turns: chat.turns.length,
      segments: chat.segments.length,
      problems: chat.problems.length,
      text_off: chat.textOff,
      bands: chat.bands?.length ?? null,
    },
    "session_chat_built",
  );
  return chat;
}

/** The chat text of the given model calls, by event id. Call it only with the content opt-in on. */
export async function loadChatTexts(
  projectId: string,
  eventIds: readonly string[],
  db: ReplayDb = getDb(),
): Promise<Map<string, ChatCallText>> {
  const out = new Map<string, ChatCallText>();
  for (let i = 0; i < eventIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: events.id, payload: events.payload })
      .from(events)
      .where(
        and(eq(events.projectId, projectId), inArray(events.id, eventIds.slice(i, i + ID_CHUNK))),
      );
    for (const row of rows) out.set(row.id, chatTextOf(row.payload));
  }
  return out;
}

/** The session's task segments as bands, named by their tasks. */
async function loadBands(
  projectId: string,
  sessionId: string,
  chat: SessionChat,
  timeline: SessionTimeline,
  db: ReplayDb,
) {
  const segments = await loadSessionSegments(projectId, sessionId, db);
  return chatBands(
    chat,
    timeline,
    segments,
    new Map(
      segments.flatMap((segment) =>
        segment.label ? [[segment.workflowId, segment.label] as const] : [],
      ),
    ),
  );
}

/** Each turn's intent name and the person's tone, by turn index. Names and labels only, never ask text. */
async function loadIntents(
  projectId: string,
  chat: SessionChat,
  db: ReplayDb,
): Promise<Record<number, TurnIntent>> {
  const indexOf = new Map(chat.turns.map((turn) => [turn.turnId, turn.turnIndex]));
  if (indexOf.size === 0) return {};
  const rows = await db
    .select({
      turnId: traceTurnTopics.turnId,
      verdict: traceTurnTopics.verdict,
      sentiment: traceTurnTopics.sentiment,
      name: traceTopics.name,
    })
    .from(traceTurnTopics)
    .leftJoin(
      traceTopics,
      and(
        eq(traceTopics.projectId, traceTurnTopics.projectId),
        eq(traceTopics.topicId, traceTurnTopics.topicId),
      ),
    )
    .where(
      and(
        eq(traceTurnTopics.projectId, projectId),
        inArray(traceTurnTopics.turnId, [...indexOf.keys()]),
      ),
    );
  const out: Record<number, TurnIntent> = {};
  for (const row of rows) {
    const topic = row.verdict === "topic" ? row.name : null;
    const sentiment =
      row.sentiment && SENTIMENTS.has(row.sentiment)
        ? (row.sentiment as TurnIntent["sentiment"])
        : null;
    if (topic === null && sentiment === null) continue;
    out[indexOf.get(row.turnId)!] = { topic, sentiment };
  }
  return out;
}
