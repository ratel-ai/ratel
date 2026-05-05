import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openai } from "@ai-sdk/openai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerMcpServer, ToolCatalog } from "@ratel-ai/sdk";
import { Chat } from "./chat.js";

const command = process.env.MCP_COMMAND ?? "npx";
const args = process.env.MCP_ARGS
  ? process.env.MCP_ARGS.split(" ")
  : ["-y", "@modelcontextprotocol/server-everything"];
const serverName = process.env.MCP_SERVER_NAME ?? "ev";
const modelId = process.env.AI_MODEL ?? "gpt-5-mini";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY not set. Export it (or set AI_MODEL + a different provider) and retry.");
  process.exit(1);
}

console.log(`spawning MCP server: ${command} ${args.join(" ")}`);
console.log(`namespace: "${serverName}"`);
console.log(`model: ${modelId}`);

const catalog = new ToolCatalog();
const transport = new StdioClientTransport({ command, args });
const handle = await registerMcpServer(catalog, { name: serverName, transport });

console.log(`\n[ratel] ${handle.toolIds.length} MCP tools registered:`);
for (const id of handle.toolIds) console.log(`  - ${id}`);
console.log("\nType your message; Ctrl-D or 'exit' to quit.");

const chat = new Chat({ model: openai(modelId), catalog });
const rl = createInterface({ input: stdin, output: stdout });

const cleanup = async () => {
  rl.close();
  await handle.close();
};

try {
  while (true) {
    const userInput = (await rl.question("\nyou> ")).trim();
    if (!userInput) continue;
    if (userInput === "exit" || userInput === "quit") break;
    try {
      const reply = await chat.send(userInput);
      console.log(`\nassistant> ${reply || "(no final text)"}`);
    } catch (err) {
      console.error(`\n[error] ${(err as Error).message}`);
    }
  }
} finally {
  await cleanup();
  console.log("\nclosed.");
}
