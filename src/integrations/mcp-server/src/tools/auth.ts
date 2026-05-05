import type { ExecutableTool, UpstreamServerInfo } from "@ratel-ai/sdk";
import type { AuthFlowOptions, AuthFlowResult } from "../oauth/flow.js";

export const AUTH_TOOL_ID = "auth";

const BASE_DESCRIPTION =
  "Re-authorize an upstream MCP server. Call this when `invoke_tool` returns " +
  "`error: needs_auth`, or proactively when the user asks to connect a new upstream. " +
  "Pass an optional `name` to target a single upstream; omit it to authorize every upstream " +
  "currently flagged as needing auth.";

export type AuthRunner = (opts?: AuthFlowOptions) => Promise<AuthFlowResult[]>;

export function authTool(
  upstreams: readonly UpstreamServerInfo[],
  runAuthFlow: AuthRunner,
): ExecutableTool {
  const tool: ExecutableTool = {
    id: AUTH_TOOL_ID,
    name: AUTH_TOOL_ID,
    description: "",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "name of the upstream server to authorize. Omit to authorize every upstream " +
            "currently flagged as needing auth.",
        },
      },
    },
    outputSchema: { type: "object" },
    execute: async (input) => {
      const args = (input ?? {}) as { name?: string };
      const opts: AuthFlowOptions = {};
      if (typeof args.name === "string" && args.name.length > 0) opts.name = args.name;
      try {
        const results = await runAuthFlow(opts);
        return { results };
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        const row: AuthFlowResult = { name: opts.name ?? "*", status: "failed", reason };
        return { results: [row] };
      }
    },
  };
  Object.defineProperty(tool, "description", {
    enumerable: true,
    get: () => buildDescription(upstreams),
  });
  return tool;
}

function buildDescription(upstreams: readonly UpstreamServerInfo[]): string {
  const flagged = upstreams.filter((u) => u.needsAuth).map((u) => u.name);
  if (flagged.length === 0) return BASE_DESCRIPTION;
  return `${BASE_DESCRIPTION}\n\nCurrently needs auth: ${flagged.join(", ")}.`;
}
