import type {
  CatalogRegistration,
  JSONSchema7,
  RatelAdapter,
  RecallRef,
  SearchCapabilitiesResult,
} from "@ratel-ai/sdk";
import { SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import { asSchema, jsonSchema, type ModelMessage, type Tool, tool } from "ai";

/**
 * The Vercel AI SDK adapter: `ratel(config).adaptTo(aiSdk())` gives the
 * framework-neutral core `ai@7`'s native {@link Tool} and {@link ModelMessage}
 * shapes. The core owns every guard (reserved ids, top-K clamp,
 * first-registration-wins, recall-id counter), so the adapter is just the three
 * codecs — `ingest` / `expose` / `recallMessages`.
 *
 * @returns A {@link RatelAdapter} over the AI SDK's tool and message types.
 */
export function aiSdk(): RatelAdapter<Tool, ModelMessage> {
  return {
    name: "ai-sdk",

    ingest(id, t) {
      const execute = t.execute;
      // Provider- or client-executed tools can't run through the catalog, so the
      // core keeps them eagerly exposed (passthrough) rather than ingesting them.
      if (!execute) return "passthrough";
      const registration: CatalogRegistration = {
        description: resolveDescription(t.description),
        inputSchema: toJsonSchema(t.inputSchema),
        execute: (input) =>
          (execute as (input: unknown, options: unknown) => unknown)(input, {
            // Catalog executors receive only the args object: fabricate minimal
            // AI SDK execution options so a tool reading options.messages /
            // options.context gets a fake ([] / undefined) rather than crashing.
            // ai@7 requires `context`, so it is present (undefined) on purpose.
            toolCallId: `ratel_${id}`,
            messages: [],
            context: undefined,
          }),
      };
      // Leave a missing output schema absent — the core defaults it to
      // `{ type: "object" }`; the adapter never fabricates one.
      if (t.outputSchema) registration.outputSchema = toJsonSchema(t.outputSchema);
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
// catalog's public {@link JSONSchema7} spelling — one of the adapter's two
// JSONSchema7 cast points.
function toJsonSchema(schema: unknown): JSONSchema7 {
  return asSchema(schema as never).jsonSchema as unknown as JSONSchema7;
}
