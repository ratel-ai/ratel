import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerMcpServer, ToolCatalog } from "@ratel-ai/sdk";

const query = process.argv.slice(2).join(" ") || "echo a message";

const command = process.env.MCP_COMMAND ?? "npx";
const args = process.env.MCP_ARGS
  ? process.env.MCP_ARGS.split(" ")
  : ["-y", "@modelcontextprotocol/server-everything"];
const serverName = process.env.MCP_SERVER_NAME ?? "ev";

console.log(`spawning MCP server: ${command} ${args.join(" ")}`);
console.log(`namespace: "${serverName}"\n`);

const catalog = new ToolCatalog();
const transport = new StdioClientTransport({ command, args });
const handle = await registerMcpServer(catalog, { name: serverName, transport });

console.log(`registered ${handle.toolIds.length} tools:`);
for (const id of handle.toolIds) console.log(`  - ${id}`);

console.log(`\nsearch ${JSON.stringify(query)} → top 5:`);
for (const hit of catalog.search(query, 5)) {
  console.log(`  ${hit.toolId.padEnd(40)} score=${hit.score.toFixed(3)}`);
}

const echoId = handle.toolIds.find((id) => id.endsWith("__echo"));
if (echoId) {
  console.log(`\ninvoking ${echoId} { message: ${JSON.stringify(query)} }`);
  const result = await catalog.invoke(echoId, { message: query });
  console.log("result:", JSON.stringify(result, null, 2));
}

await handle.close();
console.log("\nclosed.");
