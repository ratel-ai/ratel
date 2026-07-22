import type {
  CatalogRegistration,
  JSONSchema7,
  RatelAdapter,
  RecallRef,
  SearchCapabilitiesResult,
} from "@ratel-ai/sdk";
import { SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import { asSchema, jsonSchema, type ModelMessage, type Tool, tool } from "ai";

type SchemaField = "inputSchema" | "outputSchema";

/**
 * The AI SDK-idiomatic per-turn recall helpers {@link aiSdk} merges onto the
 * adapted view via the SPI's `extend` hook. Two ways to inject the same
 * synthetic `search_capabilities` pair; pick one per host (see the package
 * README's cache trade-off).
 */
export interface AiSdkExt {
  /**
   * Rank the catalog against the last user message and append the synthetic
   * `search_capabilities` pair at the transcript suffix (recall mode), then
   * return `messages`. Mutates and returns the same array so prior turns' recalls
   * stay in the history — a suffix append extends the cached prefix instead of
   * busting it. Async (core recall is async). A no-op that returns `messages`
   * untouched and spends no call id unless the last message is a user turn with
   * text and there are hits. Hosts that rebuild the array per request must
   * persist the appended pair themselves.
   */
  appendRecall(messages: ModelMessage[]): Promise<ModelMessage[]>;
  /**
   * A `prepareStep` for `generateText` / `streamText` / `ToolLoopAgent`: on step
   * 0 with a user turn and hits, return a fresh messages array with the recall
   * pair appended (never mutating the caller's — an ai `messages` override
   * carries forward across steps); `undefined` on every other path (later steps,
   * no user text, no hits), spending no call id. Structurally assignable to
   * `PrepareStepFunction<TOOLS>` for any `TOOLS`.
   */
  prepareStep(options: {
    stepNumber: number;
    messages: ModelMessage[];
  }): Promise<{ messages: ModelMessage[] } | undefined>;
}

/**
 * The Vercel AI SDK adapter: `ratel(config).adaptTo(aiSdk())` gives the
 * framework-neutral core `ai@7`'s native {@link Tool} and {@link ModelMessage}
 * shapes. The core owns every guard (reserved ids, top-K clamp,
 * first-registration-wins, recall-id counter), so the adapter is just the three
 * codecs — `ingest` / `expose` / `recallMessages` — plus the {@link AiSdkExt}
 * recall helpers.
 *
 * @returns A {@link RatelAdapter} over the AI SDK's tool and message types.
 */
export function aiSdk(): RatelAdapter<Tool, ModelMessage, AiSdkExt> {
  return {
    name: "ai-sdk",

    ingest(id, t) {
      const execute = t.execute;
      const toolType = (t as { type?: string }).type;
      // Two kinds of tool must stay eagerly exposed in native shape rather than
      // being funneled through the catalog:
      //   - any provider-defined tool (`provider-defined` in ai@5, `provider` in
      //     ai@6/7) — the catalog can't carry its load-bearing type /
      //     `<provider>.<tool>` id / args and it has no rankable description, so
      //     it passes through even when it supplies its own client-side `execute`;
      //   - any tool with no `execute` (provider- or client-run) — not invocable
      //     through the catalog at all.
      if (toolType === "provider" || toolType === "provider-defined" || !execute) {
        return "passthrough";
      }
      const registration: CatalogRegistration = {
        description: resolveDescription(t.description),
        inputSchema: toJsonSchema(id, "inputSchema", t.inputSchema),
        execute: (input) =>
          (execute as (input: unknown, options: unknown) => unknown)(input, {
            // Catalog executors receive only the args object: fabricate minimal
            // AI SDK execution options so a tool reading options.messages or its
            // version's context field gets a fake ([] / undefined) rather than
            // crashing. ai@5/6 use `experimental_context`; ai@7 uses `context`.
            toolCallId: `ratel_${id}`,
            messages: [],
            experimental_context: undefined,
            context: undefined,
          }),
      };
      // Leave a missing output schema absent — the core defaults it to
      // `{ type: "object" }`; the adapter never fabricates one.
      if (t.outputSchema) {
        registration.outputSchema = toJsonSchema(id, "outputSchema", t.outputSchema);
      }
      return registration;
    },

    expose(t) {
      return tool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema as Record<string, unknown>),
        execute: (args) => t.execute(args),
      });
    },

    recallMessages(ref: RecallRef, recall: SearchCapabilitiesResult): ModelMessage[] {
      return [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: ref.callId,
              toolName: SEARCH_CAPABILITIES_ID,
              input: { query: ref.query },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: ref.callId,
              toolName: SEARCH_CAPABILITIES_ID,
              output: { type: "text", value: JSON.stringify(recall) },
            },
          ],
        },
      ];
    },

    extend(base) {
      return {
        async appendRecall(messages) {
          const query = lastUserText(messages);
          if (!query) return messages;
          // base.recall mints the id and returns [] on no hits (spending none).
          messages.push(...(await base.recall(query)));
          return messages;
        },

        async prepareStep({ stepNumber, messages }) {
          // Recall belongs only on the first step's freshly-built prompt.
          if (stepNumber !== 0) return undefined;
          const query = lastUserText(messages);
          if (!query) return undefined;
          const pair = await base.recall(query);
          if (pair.length === 0) return undefined;
          // Fresh array: an ai `messages` override carries forward across steps,
          // so never mutate the caller's array.
          return { messages: [...messages, ...pair] };
        },
      };
    },
  };
}

// Retrieval ranks on the description, so resolve an AI SDK dynamic description at
// ingest time. There is no live tool context yet, so pass the same fabricated
// null context the catalog executor gets.
function resolveDescription(
  description: string | ((options: never) => string) | undefined,
): string {
  if (typeof description === "function") return description({ context: undefined } as never);
  return description ?? "";
}

// Convert an AI SDK FlexibleSchema (zod, JSON-Schema wrapper, ...) into the
// catalog's public {@link JSONSchema7} spelling. Ratel registration is
// synchronous, so fail before the staged batch commits when ai exposes a
// Promise-like JSON Schema.
function toJsonSchema(id: string, field: SchemaField, schema: unknown): JSONSchema7 {
  const converted = asSchema(schema as never).jsonSchema as unknown;
  if (isPromiseLike(converted)) {
    throw new TypeError(
      `ratel: AI SDK tool "${id}" has an asynchronous ${field}; ` +
        "@ratel-ai/vercel-ai-sdk requires schemas to resolve synchronously",
    );
  }
  return converted as JSONSchema7;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

// The recall query is the last message's text iff it is a user turn: recall only
// fires right after the user's turn was pushed, which also makes a second call in
// the same turn a no-op (the last message is then a tool result). Multi-part text
// joins with newlines.
function lastUserText(messages: ModelMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "user") return undefined;
  if (typeof last.content === "string") return last.content || undefined;
  const text = last.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}
