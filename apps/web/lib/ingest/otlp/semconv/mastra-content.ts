import { ancestorsOf } from "../attr-resolve";
import { GEN_AI, GEN_AI_INFERENCE_DETAILS } from "../constants";
import { isAnchor, isExecuteTool } from "../group";
import { splitPromptMessages } from "../normalize-ai-sdk";
import type { AttrValue, DecodedSpan } from "../types";

/**
 * Flag `cloud-otlp-semconv-aliases`: Mastra's input messages onto its model
 * call. `@mastra/otel-exporter` puts `gen_ai.output.messages` on the `chat`
 * span (the anchor) but sends the input only on the spans around it:
 * `mastra.model_step.input` on `agent_step` (this step's input) and
 * `mastra.model_generation.input` on `model_generation` (the first step's).
 * Both are AI SDK message lists, so the AI SDK converter reads them.
 *
 * Only adds keys to an anchor that has no input messages on the span or its
 * details event; the spans around it stay as they are, so no anchor is added.
 */

const MASTRA_INPUT_KEYS = ["mastra.model_step.input", "mastra.model_generation.input"] as const;

/** Mutates `anchor`. `byId` indexes the export the anchor came in. */
export function mapMastraInput(anchor: DecodedSpan, byId: ReadonlyMap<string, DecodedSpan>): void {
  const details = anchor.events.find((e) => e.name === GEN_AI_INFERENCE_DETAILS)?.attributes ?? {};
  const has = (key: string) => present(anchor.attributes[key]) || present(details[key]);
  if (has(GEN_AI.inputMessages)) return;
  const messages = nearestMastraInput(anchor, byId);
  if (!messages) return;
  const { systemInstructions, inputMessages } = splitPromptMessages(messages as AttrValue);
  if (!inputMessages) return;
  anchor.attributes[GEN_AI.inputMessages] = inputMessages;
  if (systemInstructions && !has(GEN_AI.systemInstructions)) {
    anchor.attributes[GEN_AI.systemInstructions] = systemInstructions;
  }
}

/**
 * The first Mastra input on the span or its nearest ancestor, as a message
 * list. The walk stops at a tool or another model call: a call under it (a
 * sub-agent, a direct client call) is not the step's call.
 */
function nearestMastraInput(
  anchor: DecodedSpan,
  byId: ReadonlyMap<string, DecodedSpan>,
): unknown[] | undefined {
  for (const span of [anchor, ...ancestorsOf(anchor, byId)]) {
    if (span !== anchor && (isExecuteTool(span) || isAnchor(span))) return undefined;
    for (const key of MASTRA_INPUT_KEYS) {
      const messages = messageList(span.attributes[key]);
      if (messages) return messages;
    }
  }
  return undefined;
}

/** A message list, or `{ messages: [...] }` as `model_generation` sends it. */
function messageList(value: AttrValue | undefined): unknown[] | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : undefined;
  if (parsed && typeof parsed === "object")
    return messageList((parsed as { messages?: AttrValue }).messages);
  return undefined;
}

function present(value: AttrValue | undefined): boolean {
  return value !== undefined && value !== null && value !== "";
}
