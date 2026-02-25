import type { ServerTool, ToolDefinition } from "./types.js";

export function tool(def: ToolDefinition): ServerTool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.metadata && { metadata: def.metadata }),
    fields: {
      name: def.name,
      description: def.description,
      inputSchema: JSON.stringify(def.parameters),
    },
  };
}
