import "./env.js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { ModelMessage } from "ai";
import { reply } from "./agent.js";
import { routeModelIdsToBedrock } from "./bedrock.js";
import { inAgentTurn, setupTelemetry } from "./telemetry.js";
import { describeStore } from "./tickets.js";

// Chat with the docs agent in the terminal. Each user turn is one
// `invoke_agent docs-agent` trace; the session is its gen_ai.conversation.id.

routeModelIdsToBedrock();
const telemetry = setupTelemetry();
const sessionId = `sess_${randomUUID()}`;
const history: ModelMessage[] = [];
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`Ratel docs agent (session ${sessionId}). Tickets go to ${describeStore()}.`);
console.log(
  telemetry.exporting ? "Traces go to Ratel." : "Set RATEL_API_KEY to send traces to Ratel.",
);
console.log("Ask a question, or press Ctrl+D to quit.\n");

rl.on("close", () => {
  void telemetry.shutdown().finally(() => process.exit(0));
});

for (;;) {
  const question = await rl.question("you> ").catch(() => undefined);
  if (question === undefined) break;
  if (!question.trim()) continue;
  history.push({ role: "user", content: question });
  process.stdout.write("agent> ");
  const turn = await inAgentTurn(sessionId, () =>
    reply(history, undefined, { onText: (t) => process.stdout.write(t) }),
  );
  history.push(...turn.messages);
  for (const message of turn.messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") process.stdout.write(`\n  [${part.toolName}]`);
    }
  }
  process.stdout.write("\n\n");
}
