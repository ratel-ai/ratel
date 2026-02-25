import { createTool } from "@mastra/core/tools";
import { z, type ZodTypeAny } from "zod";
import type { RankedTool } from "@agentified/sdk";
import { TOOL_DEFINITIONS, toolHandlers } from "./index.js";

export function buildMastraToolsFromRanked(ranked: RankedTool[]) {
  const names = new Set(ranked.map((t) => t.name));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  for (const def of TOOL_DEFINITIONS) {
    if (!names.has(def.name)) continue;
    const handler = toolHandlers[def.name];
    if (!handler) continue;

    tools[def.name] = createTool({
      id: def.name,
      description: def.description,
      inputSchema: jsonSchemaToZod(def.parameters),
      execute: async (inputData) => handler(inputData as Record<string, unknown>),
    });
  }

  return tools;
}

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<Record<string, ZodTypeAny>> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(props)) {
    let field = jsonSchemaFieldToZod(prop);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return z.object(shape).passthrough();
}

function jsonSchemaFieldToZod(prop: Record<string, unknown>): ZodTypeAny {
  const type = prop.type as string | undefined;
  const desc = prop.description as string | undefined;

  let field: ZodTypeAny;

  if (prop.enum) {
    const values = prop.enum as string[];
    field = z.enum(values as [string, ...string[]]);
  } else if (type === "number" || type === "integer") {
    field = z.number();
  } else if (type === "boolean") {
    field = z.boolean();
  } else if (type === "array") {
    const items = (prop.items ?? {}) as Record<string, unknown>;
    field = z.array(jsonSchemaFieldToZod(items));
  } else if (type === "object") {
    if (prop.properties) {
      field = jsonSchemaToZod(prop as Record<string, unknown>);
    } else {
      field = z.record(z.unknown());
    }
  } else {
    field = z.string();
  }

  if (desc) field = field.describe(desc);
  return field;
}
