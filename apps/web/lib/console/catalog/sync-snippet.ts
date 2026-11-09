import { apiUrl } from "@/lib/platform/app-config";

/**
 * The SDK snippet that registers a tool and attaches the platform, shown
 * wherever the console teaches tool sync. A plain module, so a client view can
 * use it without pulling in the component that renders it. Owned: upstream's
 * attach call relies on its SDK's hosted default address; this one names this
 * deployment's API root, so the runtime's catalog and events land here.
 */
export const TOOL_CATALOG_SNIPPET = `import { ratel } from "@ratel-ai/sdk";
import * as ratelCloud from "@ratel-ai/cloud-sdk/runtime";

const runtime = ratel();
ratelCloud.attach(runtime, { baseUrl: "${apiUrl()}", useCloudDefinitions: true }); // Reads RATEL_API_KEY.

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
