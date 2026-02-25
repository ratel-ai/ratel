/**
 * Seed script for context-base benchmark.
 * Registers all ~205 tools from the tool registry into the agentified-core server.
 *
 * Run with: pnpm seed
 */

import { z } from "zod";
import { TOOL_CATEGORIES, toolRegistry } from "../tools/registry.js";
import { TOOL_DEPENDENCIES } from "../tools/dependencies.js";

const ENDPOINT =
  process.env.AGENTIFIED_ENDPOINT ?? "http://localhost:9119";
const BATCH_SIZE = 50;

interface ToolPayload {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Build reverse map: toolName → category
const toolToCategory = new Map<string, string>();
for (const [category, toolNames] of Object.entries(TOOL_CATEGORIES)) {
  for (const toolName of toolNames) {
    toolToCategory.set(toolName, category);
  }
}

function buildToolPayloads(): ToolPayload[] {
  const entries = Object.entries(toolRegistry);
  return entries.map(([name, t]) => ({
    name,
    description: t.description ?? "",
    parameters: z.toJSONSchema(t.inputSchema as z.ZodType),
    metadata: {
      category: toolToCategory.get(name) ?? "unknown",
      ...(TOOL_DEPENDENCIES[name]?.provides && { provides: TOOL_DEPENDENCIES[name].provides }),
      ...(TOOL_DEPENDENCIES[name]?.requires && { requires: TOOL_DEPENDENCIES[name].requires }),
    },
  }));
}

async function seedBatch(batch: ToolPayload[]): Promise<number> {
  const res = await fetch(`${ENDPOINT}/api/v1/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tools: batch }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/v1/tools failed: ${res.status} ${text}`);
  }

  const result = (await res.json()) as { registered: number };
  return result.registered;
}

async function main() {
  const tools = buildToolPayloads();
  console.log("=".repeat(60));
  console.log("context-base benchmark — seed tools");
  console.log("=".repeat(60));
  console.log(`Target: ${ENDPOINT}`);
  console.log(`Tools:  ${tools.length}`);

  console.log(`\nSeeding ${tools.length} tools in batches of ${BATCH_SIZE}...`);
  let total = 0;
  for (let i = 0; i < tools.length; i += BATCH_SIZE) {
    const batch = tools.slice(i, i + BATCH_SIZE);
    const registered = await seedBatch(batch);
    total += registered;
    console.log(
      `  batch ${Math.floor(i / BATCH_SIZE) + 1}: ${registered} tools`,
    );
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Seed complete: ${total} tools registered`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
