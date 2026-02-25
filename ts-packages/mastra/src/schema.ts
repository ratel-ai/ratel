import { z, type ZodTypeAny } from "zod";

export function jsonSchemaToZod(
  schema: Record<string, unknown>,
): z.ZodObject<Record<string, ZodTypeAny>> {
  const props = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
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
