import type { ExecutableTool } from "@ratel-ai/sdk";
import { jsonSchema, tool } from "ai";

export function toAISDKTool(executable: ExecutableTool) {
  return tool({
    description: executable.description,
    inputSchema: jsonSchema(executable.inputSchema),
    execute: executable.execute,
  });
}
