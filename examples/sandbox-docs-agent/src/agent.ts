import { resolveLocal } from "@ratel-ai/sandbox";
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { readDoc, searchDocs } from "./docs.js";
import { createTicket } from "./tickets.js";

// The docs agent: answers questions about Ratel from its docs and opens a
// support ticket when it cannot help. Its config is one `defaults` object; the
// sandbox (docs-agent.sandbox.ts) changes it per run, production reads it unchanged.

export const SYSTEM = `You are the Ratel docs assistant. Answer questions about Ratel from its docs.
Search the docs first, then read the most relevant page before you answer. Keep answers short and quote commands exactly.
If the docs do not solve the user's problem, offer to open a support ticket, and open it only when the user asks.`;

export const tools = {
  searchDocs: tool({
    description: "Search the Ratel docs by keywords. Returns the best matching pages.",
    inputSchema: z.object({ query: z.string().describe("Keywords, e.g. 'api key 401'") }),
    execute: async ({ query }) => searchDocs(query),
  }),
  readDoc: tool({
    description: "Read one Ratel docs page by its slug, as returned by searchDocs.",
    inputSchema: z.object({ slug: z.string() }),
    execute: async ({ slug }) => readDoc(slug) ?? { error: `no page ${slug}` },
  }),
  createTicket: tool({
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
};

export const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
export const BEDROCK_PREFIX = "amazon-bedrock/";

/** The default model: DOCS_AGENT_MODEL when set (e.g. `amazon-bedrock/eu.anthropic.claude-haiku-5-5`). */
export function docsModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOCS_AGENT_MODEL || DEFAULT_MODEL;
}

/**
 * The agent's config, owned by the code. The model ID goes through AI Gateway,
 * or through Bedrock for an `amazon-bedrock/` ID (see bedrock.ts).
 */
export const docsDefaults = {
  model: docsModelId(),
  system: SYSTEM,
  maxSteps: 5,
  tools,
};

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
 * message. Production calls it with the defaults; the sandbox passes per-run params.
 */
export async function reply(
  messages: ModelMessage[],
  cfg: DocsConfig = resolveLocal(docsDefaults, { sandbox: "docs-agent" }),
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
