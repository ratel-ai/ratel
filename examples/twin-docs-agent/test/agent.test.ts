import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  RATEL_TWIN_CONFIG_HASH,
  resolveLocal,
  resolveParams,
  runTwin,
  type ToolChannel,
} from "@ratel-ai/twin";
import type { LanguageModel, ModelMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import docsTwin from "../docs-agent.twin.js";
import { docsDefaults, reply } from "../src/agent.js";
import { SESSIONS } from "../src/seed.js";
import { ConversationIdProcessor, inAgentTurn } from "../src/telemetry.js";
import { listTickets } from "../src/tickets.js";

// The docs agent with a scripted model (no key, no network): the production
// path, the twin path with a faked createTicket, and the seed sessions.

type Step = { tool: string; input: unknown } | { text: string };

/** An AI SDK model (spec v2) that plays one scripted step per call. */
function scriptedModel(steps: Step[]) {
  const prompts: unknown[][] = [];
  const model = {
    specificationVersion: "v2",
    provider: "scripted",
    modelId: "scripted",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("stream only");
    },
    doStream: async (options: { prompt: unknown[] }) => {
      prompts.push(options.prompt);
      const step = steps[prompts.length - 1] ?? { text: "(no more steps)" };
      const parts =
        "tool" in step
          ? [
              {
                type: "tool-call",
                toolCallId: `call_${prompts.length}`,
                toolName: step.tool,
                input: JSON.stringify(step.input),
              },
              { type: "finish", finishReason: "tool-calls", usage: USAGE },
            ]
          : [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ];
      return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
    },
  };
  return { model: model as unknown as LanguageModel, prompts };
}

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const TICKET_SCRIPT: Step[] = [
  { tool: "searchDocs", input: { query: "api key 401" } },
  { tool: "readDoc", input: { slug: "api-keys" } },
  { tool: "createTicket", input: { title: "401 from /v1/traces", body: "Key starts with rtl_." } },
  { text: "I opened a ticket for you." },
];
const CONVERSATION: ModelMessage[] = [
  { role: "user", content: "How do I send my first trace?" },
  { role: "assistant", content: "Create a key, then post a span to /v1/traces." },
  { role: "user", content: "I get a 401. Please open a ticket." },
];

let dir: string;
let db: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-agent-"));
  db = join(dir, "tickets.sqlite");
  process.env.TICKETS_DB = db;
});
afterAll(() => {
  delete process.env.TICKETS_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe("production reply()", () => {
  it("searches, reads and opens a real ticket in the SQLite file", async () => {
    const { model, prompts } = scriptedModel(TICKET_SCRIPT);
    const turn = await reply(CONVERSATION, { ...docsDefaults, model });
    expect(turn.text).toBe("I opened a ticket for you.");
    expect(prompts).toHaveLength(4);
    expect((await listTickets(db))).toMatchObject([{ id: 1, title: "401 from /v1/traces" }]);
    const toolResults = turn.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => (m.role === "tool" ? m.content : []))
      .map((p) => (p.type === "tool-result" ? p.toolName : ""));
    expect(toolResults).toEqual(["searchDocs", "readDoc", "createTicket"]);
  });

  it("stamps the production config hash, equal to the twin's baseline hash", () => {
    const provider = new NodeTracerProvider();
    provider.register();
    let stamped: unknown;
    trace.getTracer("t").startActiveSpan("invoke_agent docs-agent", (span) => {
      // What reply() does with no cfg: the defaults, read through resolveLocal.
      resolveLocal(docsDefaults, { twin: "docs-agent" });
      stamped = (span as unknown as { attributes: Record<string, unknown> }).attributes[
        RATEL_TWIN_CONFIG_HASH
      ];
      span.end();
    });
    expect(stamped).toBe(resolveParams(docsTwin, {}).configHash);
    trace.disable();
  });

  it("puts the session's gen_ai.conversation.id on every span of a turn", async () => {
    const memory = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new ConversationIdProcessor(), new SimpleSpanProcessor(memory)],
    });
    provider.register();
    const { model } = scriptedModel([{ tool: "searchDocs", input: { query: "mcp" } }, { text: "Hi." }]);
    await inAgentTurn("sess_test", () =>
      reply([{ role: "user", content: "mcp?" }], { ...docsDefaults, model }),
    );
    const spans = memory.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(
      expect.arrayContaining(["invoke_agent docs-agent", "ai.streamText", "ai.toolCall"]),
    );
    for (const span of spans) expect(span.attributes["gen_ai.conversation.id"]).toBe("sess_test");
    await provider.shutdown();
    trace.disable();
  });
});

describe("the docs-agent twin", () => {
  it("runs the real reply with a faked createTicket by default, and the SQLite file does not change", async () => {
    const { model } = scriptedModel(TICKET_SCRIPT);
    const before = (await listTickets(db));
    const fakes: string[] = [];
    const channel: ToolChannel = {
      fake: async (request) => {
        fakes.push(request.tool);
        return { result: { ticketId: "T-FAKE", status: "open" }, isError: false, source: "generated" };
      },
      confirm: async () => ({ decision: "reject" }),
    };
    const deltas: string[] = [];
    const run = await runTwin(
      { ...docsTwin, resolve: Object.assign(() => model, { modelKind: "language-model" as const }) },
      { input: { messages: CONVERSATION }, toolChannel: channel, onText: (t) => deltas.push(t) },
    );
    expect(run.toolModes).toEqual({ searchDocs: "real", readDoc: "real", createTicket: "fake" });
    expect(fakes).toEqual(["createTicket"]);
    expect(run.output).toBe("I opened a ticket for you.");
    expect(deltas.join("")).toBe("I opened a ticket for you.");
    expect((await listTickets(db))).toEqual(before);
  });

  it("refuses to run createTicket real: it has no allowReal", async () => {
    await expect(
      runTwin(docsTwin, { input: { messages: CONVERSATION }, toolModes: { createTicket: "real" } }),
    ).rejects.toThrow("createTicket: real needs allowReal: true in the twin file");
  });
});

describe("seed sessions", () => {
  it("has about 20 scripted sessions of one to three turns", () => {
    expect(SESSIONS.length).toBeGreaterThanOrEqual(18);
    expect(SESSIONS.length).toBeLessThanOrEqual(25);
    for (const script of SESSIONS) expect(script.length).toBeGreaterThanOrEqual(1);
  });
});
