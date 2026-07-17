import type { MastraDBMessage, ToolsInput } from "@mastra/core/agent";
import type { InputProcessor, ProcessInputArgs } from "@mastra/core/processors";
import { createTool, isValidationError, noopObserve } from "@mastra/core/tools";
import type {
  CatalogRegistration,
  JSONSchema7,
  RatelAdapter,
  RecallRef,
  SearchCapabilitiesResult,
} from "@ratel-ai/sdk";
import { GET_SKILL_CONTENT_ID, INVOKE_TOOL_ID, SEARCH_CAPABILITIES_ID } from "@ratel-ai/sdk";
import { z } from "zod";

/**
 * A Mastra tool — the per-entry type of Mastra's `ToolsInput` (a `createTool`
 * result, or an AI SDK / provider tool a Mastra Agent accepts). Deliberately broad
 * so an app can register any tool its Agent could hold; `ingest` duck-types it.
 */
export type MastraTool = ToolsInput[string];

/**
 * The Mastra-idiomatic per-turn recall helper {@link mastra} merges onto the
 * adapted view via the SPI's `extend` hook.
 */
export interface MastraExt {
  /**
   * A fresh Mastra {@link InputProcessor} for an Agent's `inputProcessors`. Its
   * `processInput` runs once at the start of each generation (= once per user
   * turn): it ranks the catalog against the last user message and injects the
   * synthetic `search_capabilities` call+result before the model runs. A no-op
   * that spends no call id unless the last message is a user turn with text and
   * there are hits. A factory (not a shared instance) so several agents each get
   * their own processor.
   */
  recallProcessor(): InputProcessor;
}

/** Id of the recall input processor (stamped on the Mastra `Processor`). */
const RECALL_PROCESSOR_ID = "ratel-recall";

// The minimal execution context the catalog fabricates when it runs an ingested
// Mastra tool with just its args: `observe` is the only required field of
// `ToolExecutionContext` (the createTool wrapper fills `requestContext` itself).
// A tool reading `mastra` / `agent` / `workflow` / `abortSignal` sees `undefined`.
const CATALOG_CONTEXT = { observe: noopObserve };

/**
 * The Mastra adapter: `ratel(config).adaptTo(mastra())` gives the
 * framework-neutral core `@mastra/core`'s native {@link MastraTool} (from
 * `createTool`) and {@link MastraDBMessage} shapes. The core owns every guard
 * (reserved ids, top-K clamp, first-registration-wins, recall-id counter), so
 * the adapter is just the three codecs — `ingest` / `expose` / `recallMessages`
 * — plus the {@link MastraExt} recall processor.
 *
 * @returns A {@link RatelAdapter} over Mastra's tool and message types.
 */
export function mastra(): RatelAdapter<MastraTool, MastraDBMessage, MastraExt> {
  return {
    name: "mastra",

    ingest(_id, tool) {
      // Duck-type the tool structurally: `MastraTool` is a broad union, but the
      // codec only needs these four fields off a built Mastra tool.
      const t = tool as {
        execute?: unknown;
        description?: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
      };
      // A Mastra tool with no `execute` (client/provider-run) can't be funneled
      // through the catalog — stay eagerly exposed in native shape.
      if (typeof t.execute !== "function") return "passthrough";
      const execute = t.execute as (input: unknown, context: unknown) => unknown;
      const registration: CatalogRegistration = {
        description: t.description ?? "",
        // `createTool` normalized the input schema at build time; read its JSON
        // Schema straight off the normalized standard schema (works for tools
        // built from zod 3, zod 4, or a raw JSON Schema).
        inputSchema: toJsonSchema(t.inputSchema),
        // Catalog executors get only the args object: fabricate the minimal
        // Mastra context so a tool reading it sees a no-op rather than crashing.
        execute: async (input) => {
          const result = await execute(input, CATALOG_CONTEXT);
          // Mastra's createTool wrapper does not throw on a schema mismatch (or a
          // required requestContext the fabricated context can't satisfy) — it
          // RETURNS a ValidationError. Surface it as a real error so the capability
          // funnel reports a failed call, not a successful one carrying an error blob.
          if (isValidationError(result)) {
            throw new Error(
              (result as { message?: string }).message ?? "Mastra tool input validation failed",
            );
          }
          return result;
        },
      };
      // Leave a missing output schema absent — the core defaults it to
      // `{ type: "object" }`; the adapter never fabricates one.
      if (t.outputSchema) registration.outputSchema = toJsonSchema(t.outputSchema);
      return registration;
    },

    expose(tool) {
      return createTool({
        id: tool.id,
        description: tool.description,
        inputSchema: capabilitySchema(tool.id, tool.inputSchema as JSONSchema7),
        execute: async (input) => tool.execute(input as Record<string, unknown>),
      }) as MastraTool;
    },

    recallMessages(ref: RecallRef, recall: SearchCapabilitiesResult): MastraDBMessage[] {
      // One assistant message carrying a completed `search_capabilities` call:
      // a MastraDBMessage has no `tool` role, so a resolved tool-invocation part
      // (state `"result"`) holds both the args and the result. Mastra renders it
      // to the model as an assistant tool-call followed by a tool result.
      return [
        {
          id: ref.callId,
          role: "assistant",
          createdAt: new Date(),
          content: {
            format: 2,
            parts: [
              {
                type: "tool-invocation",
                toolInvocation: {
                  state: "result",
                  toolCallId: ref.callId,
                  toolName: SEARCH_CAPABILITIES_ID,
                  args: { query: ref.query },
                  result: recall,
                },
              },
            ],
          },
        },
      ];
    },

    extend(base) {
      return {
        recallProcessor(): InputProcessor {
          return {
            id: RECALL_PROCESSOR_ID,
            async processInput(args: ProcessInputArgs) {
              const query = lastUserText(args.messages);
              if (!query) return args.messages;
              // base.recall mints the id and returns [] on no hits (spending none).
              const pair = await base.recall(query);
              if (pair.length === 0) return args.messages;
              return [...args.messages, ...pair];
            },
          };
        },
      };
    },
  };
}

// Hand-written, deliberately permissive zod schemas for the three capability
// tools (the model-facing shapes). topK carries no int/min/max — the core owns
// clamping, so an out-of-range value must reach it rather than being rejected
// here. An unknown id (defensive: the core only exposes the three) passes the
// catalog's own JSON Schema straight through — `createTool` accepts a raw JSON
// Schema, so there is still no schema converter in the adapter.
function capabilitySchema(id: string, fallback: JSONSchema7): z.ZodTypeAny {
  switch (id) {
    case SEARCH_CAPABILITIES_ID:
      // Descriptions mirror the core's canonical schema so the model keeps the
      // same guidance; topK carries no int/min so out-of-range reaches the clamp.
      return z.object({
        query: z.string().describe("describe what you want to do"),
        topKTools: z.number().describe("max tools to return (default 5)").optional(),
        topKSkills: z.number().describe("max skills to return (default 3)").optional(),
      });
    case INVOKE_TOOL_ID:
      return z.object({
        toolId: z
          .string()
          .describe(
            "id of the tool to invoke (use the catalog's search tool to find available ids)",
          ),
        // Arbitrary nested args — a record so zod never strips the tool's fields.
        args: z
          .record(z.string(), z.unknown())
          .describe("arguments object matching the tool's inputSchema, nested as a single object"),
      });
    case GET_SKILL_CONTENT_ID:
      return z.object({
        skillId: z
          .string()
          .describe("id of the skill to load (use search_capabilities to find available ids)"),
      });
    default:
      return fallback as unknown as z.ZodTypeAny;
  }
}

// Read the JSON Schema off a built Mastra tool's normalized `inputSchema` via the
// Standard JSON Schema spec. `createTool` normalizes zod/JSON into this shape, so
// there is one extraction path for every schema flavour. A tool with no input
// schema leaves it `undefined`; the catalog wants an object schema, so default.
function toJsonSchema(schema: unknown): JSONSchema7 {
  const input = (schema as StandardJsonSchema | null | undefined)?.["~standard"]?.jsonSchema?.input;
  if (!input) return { type: "object" };
  // Drop the `$schema` dialect marker — the catalog wants a bare JSONSchema7.
  const { $schema: _dialect, ...json } = input({ target: "draft-07" });
  return json as JSONSchema7;
}

// The slice of the Standard JSON Schema spec the adapter reads off a normalized
// Mastra tool schema.
interface StandardJsonSchema {
  "~standard": { jsonSchema: { input(options: { target: string }): Record<string, unknown> } };
}

// The recall query is the last message's text iff it is a user turn: recall only
// fires right after the user's turn, which also makes a second call in the same
// turn a no-op (the last message is then an assistant/tool turn). Multi-part text
// joins with newlines.
function lastUserText(messages: MastraDBMessage[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== "user") return undefined;
  const parts = last.content?.parts ?? [];
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
  return text || undefined;
}
