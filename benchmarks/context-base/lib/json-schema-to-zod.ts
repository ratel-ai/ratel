import { z } from "zod";

/**
 * Convert a JSON Schema object to a Zod schema.
 * Local patched version: uses z.any() instead of z.unknown() to avoid
 * Mastra/zod v4 _zod serialization bug in z.record(z.unknown()).
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<any> {
  const props = (schema.properties ?? {}) as Record<string, any>;
  const required = new Set((schema.required ?? []) as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(props)) {
    let field = jsonSchemaFieldToZod(prop);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return z.object(shape).passthrough();
}

function jsonSchemaFieldToZod(prop: any): z.ZodTypeAny {
  const type = prop.type;
  const desc = prop.description;
  let field: z.ZodTypeAny;

  if (prop.enum) {
    field = z.enum(prop.enum);
  } else if (type === "number" || type === "integer") {
    field = z.number();
  } else if (type === "boolean") {
    field = z.boolean();
  } else if (type === "array") {
    const items = prop.items ?? {};
    field = z.array(jsonSchemaFieldToZod(items));
  } else if (type === "object") {
    if (prop.properties) {
      field = jsonSchemaToZod(prop);
    } else {
      field = z.record(z.string(), z.any());
    }
  } else {
    field = z.string();
  }

  if (desc) field = field.describe(desc);
  return field;
}
