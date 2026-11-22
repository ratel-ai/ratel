import { sandbox } from "@ratel-ai/sandbox";
import { aiSdkChat, aiSdkModels } from "@ratel-ai/sandbox/ai-sdk";
import { docsDefaults, reply } from "./src/agent.js";

// The docs agent's sandbox: Ratel can change its model, system prompt, max steps
// and tools per run, and runs the real `reply` with them. One run per user turn.
// `pnpm ratel sandbox verify docs-agent` proves that each of them reaches the model call.

export default sandbox("docs-agent", {
  params: {
    model: sandbox.model(docsDefaults.model),
    system: sandbox.prompt(docsDefaults.system),
    maxSteps: sandbox.int(docsDefaults.maxSteps, { min: 1, max: 10 }),
    tools: sandbox.tools(docsDefaults.tools, {
      searchDocs: { readOnly: true },
      readDoc: { readOnly: true },
      createTicket: { sideEffect: true }, // faked unless allowReal: true
    }),
  },
  input: aiSdkChat(),
  resolve: aiSdkModels(),
  // What production passes to resolveLocal, and the input of `ratel sandbox verify`.
  defaults: docsDefaults,
  example: {
    messages: [
      {
        role: "user",
        content: "I get a 401 when I send traces. Can you open a ticket? My project is demo.",
      },
    ],
  },
  run: async ({ input, params, ctx }) => {
    const { text } = await reply(input.messages, params, {
      onText: ctx.textDelta,
      abortSignal: ctx.signal,
    });
    return text;
  },
});
