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
  output: sandbox.text(),
  state: "run",
  // The image of a hosted instance. Its Postgres sidecar sets DATABASE_URL, so
  // createTicket writes there; locally, with no DATABASE_URL, it writes to SQLite.
  image: sandbox.image({
    base: "node:22-slim",
    install: ["corepack enable", "pnpm install --frozen-lockfile"],
    copy: ["."],
    sidecars: [sandbox.postgres({ version: "16", seed: "db/seed.sql" })],
    env: ["AI_GATEWAY_API_KEY", "AWS_REGION"],
  }),
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
