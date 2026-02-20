import type { FastifyInstance } from "fastify";
import type { CoreMessage } from "ai";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { mastra } from "../mastra/index.js";

export async function chatRoutes(app: FastifyInstance) {
  app.post<{ Params: { agentId: string }; Body: { messages: CoreMessage[] } }>(
    "/chat/:agentId",
    async (request, reply) => {
      const agent = mastra.getAgent(
        request.params.agentId as "app-agent",
      );
      const { messages } = request.body;
      const instructions = await agent.getInstructions();

      const result = streamText({
        model: openai("gpt-5-mini"),
        system: instructions as string,
        messages,
      });

      result.pipeDataStreamToResponse(reply.raw);
      return reply;
    },
  );
}
