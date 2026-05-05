import Fastify from "fastify";
import cors from "@fastify/cors";
import { Agent } from "@mastra/core/agent";
import { tool } from "agentified";
import { AgentifiedMastra, streamSSE } from "@agentified/mastra";
import { TOOL_DEFINITIONS, toolHandlers } from "./tools/index.js";
import { registerRoutes } from "./routes.js";

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
- PREFER frontend tools (navigate_to_page, open_add_employee_modal, open_timeoff_request_modal, etc.) over backend tools when the user asks to see or do something in the UI. Frontend tools let the user see actions happen live.
- When creating records, prefer opening the form modal with pre-filled data so the user can review before submitting.
- Use get_page_snapshot to understand what the user currently sees.
`;

const sdkTools = TOOL_DEFINITIONS.map((def) =>
  tool({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.metadata && { metadata: def.metadata }),
  }),
);

const myAgent = new Agent({
  id: "quickhr",
  name: "quickhr",
  instructions: SYSTEM_PROMPT,
  model: "google/gemini-3-flash-preview",
});

const agent = new AgentifiedMastra({
  agentifiedUrl: AGENTIFIED_URL,
  tools: sdkTools,
  toolHandlers,
  agent: myAgent,
});

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: ["*", "http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST", "OPTIONS"],
  });

  await agent.register();
  app.log.info(`Registered ${sdkTools.length} tools with Agentified`);

  registerRoutes(app);

  app.post("/api/chat", async (req, reply) => {
    const body = req.body as {
      messages?: Array<{
        role: string;
        content: string;
        toolCallId?: string;
        toolCalls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
      }>;
      forwardedProps?: { availableFrontendTools?: string[] };
    };

    const observable = await agent.run({
      messages: (body.messages ?? []).map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCallId) msg.toolCallId = m.toolCallId;
        if (m.toolCalls) msg.toolCalls = m.toolCalls;
        return msg as { role: string; content: string; toolCallId?: string; toolCalls?: typeof m.toolCalls };
      }),
      frontendTools: body.forwardedProps?.availableFrontendTools,
    });

    return streamSSE(observable, reply.raw);
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`QuickHR backend on http://localhost:${PORT}`);
  app.log.info(`Agentified Core at ${AGENTIFIED_URL}`);
}

main().catch(console.error);
