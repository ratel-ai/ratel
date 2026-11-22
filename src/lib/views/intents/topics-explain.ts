import type { IntentsReading, TopicsSummary } from "@/lib/views/intents/topics-view";

/**
 * The few sentences the Intents pages keep, one hover away from the numbers
 * they explain (DESIGN.md: show, don't explain). Pure, so the pages and their
 * tests read the same words. Never engine names: "a model", "a keyword list".
 */

const n = (value: number) => value.toLocaleString("en-US");

/** What sentiment is, the same everywhere it is drawn. */
export const SENTIMENT_MEANS =
  "From the person's own words in each ask: positive, neutral or negative.";

/** What captured text unlocks, where a reading had asks with no words or no one's own words. */
export const CAPTURE_NEEDED =
  "Intents, example asks and sentiment are read from what people wrote. Send each person's message with their run (or turn content capture on), and the next reading places those asks too.";

/** What answered means (`asks.ts` `isAnswered`). */
export const ANSWERED_MEANS =
  "A tool ran, its last call worked, and the reply didn't say it couldn't.";

/** How a reading read sentiment: on how many asks, and by a model or the keyword list. */
export function sentimentHowRead(read: TopicsSummary["sentimentRead"]): string {
  if (read.measured === 0)
    return `Read on none of ${n(read.of)} asks: it needs people's own messages, and none were captured.`;
  const on = `Read on ${n(read.measured)} of ${n(read.of)} asks`;
  if (read.model === null) return `${on}.`;
  if (read.model >= read.measured) return `${on}, by a model.`;
  if (read.model === 0) return `${on}, by a keyword list.`;
  return `${on}: ${n(read.model)} by a model, ${n(read.measured - read.model)} by a keyword list.`;
}

/** One intent's sentiment: on how many of its asks it was read. */
export function intentSentimentRead(measured: number, asks: number): string {
  return `Read on ${n(measured)} of ${n(asks)} asks.`;
}

export type FlowsGap = { title: string; body: string };

type Ready = Extract<IntentsReading, { status: "ready" }>;

/** Whether most of the reading's turns came by OpenTelemetry. */
function mostlyTelemetry(lanes: Ready["lanes"]): boolean {
  return lanes !== null && lanes.telemetry > lanes.sdk;
}

/**
 * Why Flows has nothing to follow, in plain words and with what to send; null
 * when it can draw. Sessions holding several people at once can't be trusted;
 * telemetry with no conversation id makes every ask its own conversation;
 * otherwise nobody asked twice.
 */
export function flowsGap(reading: Pick<Ready, "flows" | "lanes">): FlowsGap | null {
  const { flows, lanes } = reading;
  if (!flows) {
    return mostlyTelemetry(lanes)
      ? {
          title: "Can't follow conversations yet",
          body: "One conversation id holds several people's asks at once. Send a conversation id per conversation and a user id with each run to see what people ask next.",
        }
      : {
          title: "Can't follow conversations yet",
          body: "One session holds several people's asks, so what someone asks next can't be read. Send an end-user id and a session id per conversation with each run.",
        };
  }
  if (flows.all.sessions > 0 && flows.all.multiTurn > 0) return null;
  if (
    lanes &&
    lanes.telemetryWithoutConversation > 0 &&
    lanes.telemetryWithoutConversation * 2 >= lanes.telemetry + lanes.sdk
  ) {
    return {
      title: "Every ask stands alone",
      body: "Your runs carry no conversation id, so asks can't be joined into conversations. Send a conversation id with each run (gen_ai.conversation.id) to see what people ask next.",
    };
  }
  if (lanes && lanes.sdk > lanes.telemetry) {
    return {
      title: "Every session holds one ask",
      body: "Send the same session id for one person's asks, and an end-user id, to see what people ask next.",
    };
  }
  return { title: "No second asks yet", body: "Nobody asked a second time in the last 30 days." };
}

/** A quiet note when Flows draws but some telemetry runs carried no conversation id; null otherwise. */
export function flowsNote(reading: Pick<Ready, "lanes">): string | null {
  const missing = reading.lanes?.telemetryWithoutConversation ?? 0;
  if (missing === 0) return null;
  return `${n(missing)} ${missing === 1 ? "run carried" : "runs carried"} no conversation id, so ${missing === 1 ? "it counts" : "each counts"} as a conversation of one ask.`;
}
