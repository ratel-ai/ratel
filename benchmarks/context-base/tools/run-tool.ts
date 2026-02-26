import { handlers } from "./executor.js";

const toolName = process.argv[2];

if (!toolName || !handlers[toolName]) {
  process.stderr.write(JSON.stringify({ error: `Unknown tool: ${toolName ?? "(none)"}` }));
  process.exit(1);
}

const chunks: Buffer[] = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const args = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const result = handlers[toolName](args);
    process.stdout.write(JSON.stringify(result));
  } catch (e: any) {
    process.stderr.write(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
});
