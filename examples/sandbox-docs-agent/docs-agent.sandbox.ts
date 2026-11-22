import { sandbox } from "@ratel-ai/sandbox";
import { aiSdkChat } from "@ratel-ai/sandbox/ai-sdk";
import { reply } from "./src/agent.js";

// The docs agent's sandbox: one run per user turn of the real `reply`. It declares no
// params: the model and the system prompt that src/agent.ts reads through the Ratel
// catalog, and the tools it registers on a Ratel core, are its params by themselves.
// `pnpm ratel sandbox verify docs-agent --input chat.json` proves that each reaches the model call.

export default sandbox("docs-agent", {
  input: aiSdkChat(),
  // Not a param: the image of a hosted instance. Its Postgres sidecar sets DATABASE_URL, so
  // createTicket writes there; locally, with no DATABASE_URL, it writes to SQLite.
  image: sandbox.image({
    base: "node:22-slim",
    install: ["corepack enable", "pnpm install --frozen-lockfile"],
    copy: ["."],
    sidecars: [sandbox.postgres({ version: "16", seed: "db/seed.sql" })],
    env: ["AI_GATEWAY_API_KEY", "AWS_REGION"],
  }),
  run: async ({ input, ctx }) => {
    const { text } = await reply(input.messages, undefined, {
      onText: ctx.textDelta,
      abortSignal: ctx.signal,
    });
    return text;
  },
});
