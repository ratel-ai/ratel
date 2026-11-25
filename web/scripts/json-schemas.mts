// Writes docs/schemas from the zod schemas. `views/dashboards/document.test.ts` fails when they differ.
import { mkdirSync, writeFileSync } from "node:fs";
import { jsonSchemas } from "../src/lib/views/dashboards/json-schemas";

const directory = new URL("../../docs/schemas/", import.meta.url);
mkdirSync(directory, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas()))
  writeFileSync(new URL(name, directory), `${JSON.stringify(schema, null, 2)}\n`);
