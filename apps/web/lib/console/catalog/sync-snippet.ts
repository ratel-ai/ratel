/**
 * The SDK snippet that registers a tool, shown wherever the console teaches tool sync. A plain
 * module, so a client view can use it without pulling in the component that renders it.
 */
export const TOOL_CATALOG_SNIPPET = `import { ratel } from "@ratel-ai/sdk";

const runtime = ratel();

await runtime.tools.register({
  id: "weather.lookup",
  name: "weather.lookup",
  description: "Fetch a forecast for one city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  outputSchema: { type: "object" },
  execute: async ({ city }) => getForecast(city),
});`;
