import { parseArgs } from "node:util";
import { runSearch } from "./search.js";

const { values } = parseArgs({
  options: {
    query: { type: "string", default: "Ratel AI tool retrieval MCP" },
    url: { type: "string" },
  },
});

try {
  const result = await runSearch({ query: values.query, url: values.url });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
