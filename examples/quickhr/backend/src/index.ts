import Fastify from "fastify";
import cors from "@fastify/cors";
import { Agentified, tool } from "@agentified/sdk";
import type { Message } from "@agentified/sdk";
import { TOOL_DEFINITIONS } from "./tools/index.js";
import { registerRoutes } from "./routes.js";
import { createRequestAgent } from "./agent.js";
import { serveAgUi } from "./serve-ag-ui.js";

const PORT = Number(process.env.PORT) || 3003;
const AGENTIFIED_URL = process.env.AGENTIFIED_URL || "http://localhost:9119";

const SYSTEM_PROMPT = `You are an AI assistant embedded in QuickHR, an HR management platform.
Your role is to help HR managers and employees with HR-related tasks including:
- Employee management (viewing, adding, updating records)
- Time off and PTO requests
- Onboarding new employees
- Payroll inquiries
- Recruiting and hiring
- Benefits management
- Compliance and policies

Guidelines:
- Be professional, helpful, and efficient
- Use available tools to look up information and perform actions
- Follow company policies when processing requests
- For read-only operations (listing, viewing, searching), use tools immediately
- For write operations (adding, updating, deleting), confirm with the user first
`;

const sdkTools = TOOL_DEFINITIONS.map((def) =>
  tool({ name: def.name, description: def.description, parameters: def.parameters }),
);

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ["*", "http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST", "OPTIONS"],
  });

  // Register tools with Agentified Core
  const agentified = new Agentified({
    serverUrl: AGENTIFIED_URL,
    tools: sdkTools,
  });
  await agentified.register();
  app.log.info(`Registered ${sdkTools.length} tools with Agentified`);

  // REST endpoints
  registerRoutes(app);

  // AG-UI chat endpoint
  app.post("/api/chat", async (req, reply) => {
    const body = req.body as { messages?: Array<{ role: string; content: string }> };
    const messages: Message[] = (body.messages || []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Prefetch relevant tools
    const prefetchStart = performance.now();
    const ranked = await agentified.prefetch({ messages });
    const prefetchDurationMs = performance.now() - prefetchStart;

    req.log.info({ toolCount: ranked.length, prefetchDurationMs }, "Prefetch complete");

    const runId = crypto.randomUUID();
    const threadId = crypto.randomUUID();

    // SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // AG-UI requires RUN_STARTED as the first event
    reply.raw.write(
      `data: ${JSON.stringify({ type: "RUN_STARTED", runId, threadId })}\n\n`,
    );

    reply.raw.write(
      `data: ${JSON.stringify({
        type: "CUSTOM",
        name: "agentified:prefetch:complete",
        value: { tools: ranked, durationMs: prefetchDurationMs },
      })}\n\n`,
    );

    // Create per-request agent with prefetched tools
    const { adapter } = createRequestAgent({
      ranked,
      agentifiedUrl: AGENTIFIED_URL,
      sdkTools,
      systemPrompt: SYSTEM_PROMPT,
    });

    // Stream adapter events, skipping duplicate RUN_STARTED
    const observable = adapter.run({
      messages: messages.map((m) => ({
        id: crypto.randomUUID(),
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
      threadId,
      runId,
      tools: [],
      context: [],
    });

    let seenRunStarted = false;
    observable.subscribe({
      next: (e) => {
        if (e.type === "RUN_STARTED") {
          if (seenRunStarted) return;
          seenRunStarted = true;
          return; // already sent manually
        }
        reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      },
      complete: () => reply.raw.end(),
      error: (err) => {
        req.log.error({ err }, "Chat stream error");
        reply.raw.write(
          `data: ${JSON.stringify({ type: "RUN_ERROR", message: (err as Error).message })}\n\n`,
        );
        reply.raw.end();
      },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`QuickHR backend on http://localhost:${PORT}`);
  app.log.info(`Agentified Core at ${AGENTIFIED_URL}`);
}

main().catch(console.error);
