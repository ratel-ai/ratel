import Fastify from "fastify";
import cors from "@fastify/cors";
import { Agent } from "@mastra/core/agent";
import { tool } from "@agentified/sdk";
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
  name: "quickhr",
  instructions: SYSTEM_PROMPT,
  model: "openai/gpt-5-nano",
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
      messages?: Array<{ role: string; content: string }>;
      forwardedProps?: { availableFrontendTools?: string[] };
    };

    const observable = await agent.run({
      messages: (body.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
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
