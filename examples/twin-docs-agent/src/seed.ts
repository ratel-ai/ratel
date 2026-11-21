import "./env.js";
import type { ModelMessage } from "ai";
import { reply } from "./agent.js";
import { inAgentTurn, setupTelemetry } from "./telemetry.js";

// Writes about 20 synthetic sessions to the Ratel project of RATEL_API_KEY:
// scripted, invented questions (no real user text), one trace per user turn,
// with message content and gen_ai.conversation.id. The playground can replay
// them. Needs a model key too (AI_GATEWAY_API_KEY).

export const SESSIONS: readonly (readonly string[])[] = [
  ["How do I run Ratel on my laptop?", "Port 3000 is taken on my machine. What do I change?"],
  ["Where do I create an API key?", "I lost the key right after I created it. Can I see it again?"],
  ["What is the traces endpoint on Ratel Cloud?"],
  ["My exporter gets a 401 from /v1/traces.", "The key starts with rtl_ and I copied it twice. Please open a ticket, my email is dev@example.com."],
  ["Does Ratel need message content in traces?", "What do I lose without it?"],
  ["How do I group the turns of one conversation?"],
  ["How do I install the TypeScript SDK?", "And the Vercel AI SDK adapter?"],
  ["Which AI SDK versions does the adapter support?"],
  ["Is there a Python SDK?", "How do I add it with uv?"],
  ["How do I connect Claude Code to Ratel over MCP?"],
  ["Can Cursor talk to Ratel?"],
  ["How do I rotate an API key without downtime?"],
  ["What is an agent twin?", "What happens to a tool that sends emails when I run the twin?"],
  ["How do I run a twin on my machine?", "And how do I connect it to the playground?"],
  ["Does a key of one project see another project?"],
  ["I get a 404 for a project I own when I use the API.", "Yes I used the key of the other project. Thanks!"],
  ["What does Ratel need to run?", "Is there a separate worker to deploy?"],
  ["Can I send logs as well as traces?"],
  ["The docs do not say how to export to two backends at once. Open a ticket asking for that page."],
  ["What does fake mode do for a tool?", "Can a side-effect tool ever run for real in the playground?"],
];

async function main(): Promise<void> {
  if (!process.env.RATEL_API_KEY) throw new Error("set RATEL_API_KEY to the key of a demo project");
  const telemetry = setupTelemetry();
  const runId = Date.now().toString(36);
  let turns = 0;
  for (const [i, script] of SESSIONS.entries()) {
    const sessionId = `seed_${runId}_${String(i + 1).padStart(2, "0")}`;
    const history: ModelMessage[] = [];
    for (const question of script) {
      history.push({ role: "user", content: question });
      const turn = await inAgentTurn(sessionId, () => reply(history));
      history.push(...turn.messages);
      turns++;
    }
    console.log(`${sessionId}: ${script.length} turn(s)`);
  }
  await telemetry.shutdown();
  console.log(`seeded ${SESSIONS.length} sessions, ${turns} turns`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
