import { ratel } from "@ratel-ai/sdk";
import { ratel as catalog } from "@ratel-ai/sdk/experimental/catalog";
import { aiSdk } from "@ratel-ai/vercel-ai-sdk";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { BEDROCK_PREFIX, routeModelIds } from "./bedrock.js";
import { readDoc, searchDocs } from "./docs.js";
import { createTicket } from "./tickets.js";

// The docs agent: answers questions about Ratel from its docs and opens a
// support ticket when it cannot help. It reads its model and system prompt through
// the Ratel catalog and registers its tools on a Ratel core. That is all the sandbox
// (docs-agent.sandbox.ts) needs: they become its params with no declaration, and a
// sandbox run serves its own values through the same calls.

export { BEDROCK_PREFIX };

export const SYSTEM = `You are the Ratel docs assistant. Answer questions about Ratel from its docs.
Search the docs first, then read the most relevant page before you answer. Keep answers short and quote commands exactly.
If the docs do not solve the user's problem, offer to open a support ticket, and open it only when the user asks.`;

// MCP-style annotations set each tool's default mode in a sandbox run:
// readOnlyHint runs real, destructiveHint is faked, a tool with neither asks to confirm.
const readOnly = { annotations: { readOnlyHint: true } };
const sideEffect = { annotations: { destructiveHint: true } };

export const tools = {
  searchDocs: Object.assign(
    tool({
      description: "Search the Ratel docs by keywords. Returns the best matching pages.",
      inputSchema: z.object({ query: z.string().describe("Keywords, e.g. 'api key 401'") }),
      execute: async ({ query }) => searchDocs(query),
    }),
    readOnly,
  ),
  readDoc: Object.assign(
    tool({
      description: "Read one Ratel docs page by its slug, as returned by searchDocs.",
      inputSchema: z.object({ slug: z.string() }),
      execute: async ({ slug }) => readDoc(slug) ?? { error: `no page ${slug}` },
    }),
    readOnly,
  ),
  createTicket: Object.assign(
    tool({
      description: "Open a support ticket for the Ratel team. Only when the user asks for one.",
      inputSchema: z.object({
        title: z.string().min(3).describe("One line that names the problem"),
        body: z.string().describe("What the user tried and what happened"),
        email: z.string().optional().describe("Where the team can answer, if the user gave it"),
      }),
      execute: async (ticket) => {
        const created = await createTicket(ticket);
        return { ticketId: `T-${created.id}`, status: "open" };
      },
    }),
    sideEffect,
  ),
};

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
export const MAX_STEPS = 5;

/** The default model: DOCS_AGENT_MODEL when set (e.g. `amazon-bedrock/eu.anthropic.claude-haiku-5-5`). */
export function docsModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCS_AGENT_MODEL || DEFAULT_MODEL;
}

/**
 * The agent's config for one turn, read through the Ratel catalog: a sandbox run's
 * values inside a run, else `ratel.catalog.json` when present, else the code's
 * defaults. The model ID goes through AI Gateway, or to Bedrock for an
 * `amazon-bedrock/` ID (see bedrock.ts).
 */
export function docsConfig(): DocsConfig {
  return {
    model: catalog.model("model", docsModelId()),
    system: catalog.prompt("system", SYSTEM),
    maxSteps: MAX_STEPS,
    tools: catalog.toolset(tools),
  };
}

// Registered once, on load: Ratel lists the tools, and a sandbox makes them a param.
await ratel().adaptTo(aiSdk()).tools.register(tools);
routeModelIds();
// The config on load: a sandbox finds the model and the prompt without a run.
export const docsDefaults = docsConfig();

export interface DocsConfig {
  readonly model: LanguageModel;
  readonly system: string;
  readonly maxSteps: number;
  readonly tools: typeof tools;
}

export interface ReplyOptions {
  /** Receives each piece of the answer as it streams. */
  readonly onText?: (text: string) => void;
  readonly abortSignal?: AbortSignal;
}

export interface Reply {
  readonly text: string;
  /** The assistant and tool messages of this turn, to append to the history. */
  readonly messages: ModelMessage[];
}

/**
 * One user turn: `messages` is the conversation so far, ending with the user's
 * message. Production and the sandbox both call it with no cfg; tests pass their own.
 */
export async function reply(
  messages: ModelMessage[],
  cfg: DocsConfig = docsConfig(),
  options: ReplyOptions = {},
): Promise<Reply> {
  const result = streamText({
    model: cfg.model,
    system: cfg.system,
    messages,
    tools: cfg.tools,
    stopWhen: stepCountIs(cfg.maxSteps),
    abortSignal: options.abortSignal,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "docs-agent",
      recordInputs: true,
      recordOutputs: true,
    },
  });
  let text = "";
  for await (const piece of result.textStream) {
    text += piece;
    options.onText?.(piece);
  }
  return { text, messages: (await result.response).messages };
}
