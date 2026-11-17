import { and, eq, inArray } from "drizzle-orm";
import { events } from "@/lib/ingest/otlp/schema";
import { getDb } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { loadSessionLens } from "@/lib/views/session-replay/annotations-load";
import { loadSessionReplay, type ReplayDb } from "@/lib/views/session-replay/load";
import { buildSessionChat, type ChatCallText, type SessionChat } from "./model";
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

/** The session as a chat, or null when the project has no closed turn in it. */
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
  // The context split of each call: counts only, the same lens as the step-by-step view.
  chat.splits = Object.fromEntries(
    lens.calls.map((call) => [
      call.step,
      { inputTokens: call.composition.inputTokens, parts: call.composition.parts },
    ]),
  );
  logger.info(
    {
      project_id: projectId,
      turns: chat.turns.length,
      segments: chat.segments.length,
      problems: chat.problems.length,
      text_off: chat.textOff,
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
