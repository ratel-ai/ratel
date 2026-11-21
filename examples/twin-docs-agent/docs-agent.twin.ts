import { twin } from "@ratel-ai/twin";
import { aiSdkChat, aiSdkModels } from "@ratel-ai/twin/ai-sdk";
import { docsDefaults, reply } from "./src/agent.js";

// The docs agent's twin: Ratel can change its model, system prompt, max steps
// and tools per run, and runs the real `reply` with them. One run per user turn.
// `pnpm ratel twin verify docs-agent` proves that each of them reaches the model call.

export default twin("docs-agent", {
  params: {
    model: twin.model(docsDefaults.model),
    system: twin.prompt(docsDefaults.system),
    maxSteps: twin.int(docsDefaults.maxSteps, { min: 1, max: 10 }),
    tools: twin.tools(docsDefaults.tools, {
      searchDocs: { readOnly: true },
      readDoc: { readOnly: true },
      createTicket: { sideEffect: true }, // faked unless allowReal: true
    }),
  },
  input: aiSdkChat(),
  resolve: aiSdkModels(),
  // What production passes to resolveLocal, and the input of `ratel twin verify`.
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
