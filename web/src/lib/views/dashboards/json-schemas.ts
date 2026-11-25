import { z } from "zod";
import { querySchema } from "@/lib/contracts/query";
import { dashboardDocumentSchema } from "@/lib/views/dashboards/document";

/** The published JSON Schemas, by file name under `docs/schemas`. */
export function jsonSchemas(): Record<string, object> {
  return {
    "query.schema.json": schemaOf("Ratel query", querySchema),
    "dashboard.schema.json": schemaOf("Ratel dashboard", dashboardDocumentSchema),
  };
}

function schemaOf(title: string, schema: z.ZodType): object {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return { $schema, title, ...rest };
}
