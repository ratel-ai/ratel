import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchDeps, dispatchOperation } from "@/lib/mcp/dispatch";
import type { McpOperation, Registry } from "@/lib/mcp/registry";
import { stageMeta, TOOL_STAGES } from "@/lib/mcp/stages";

export const MCP_SERVER_NAME = "ratel-cloud";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * How the model is told to use this server. Deliberately short: it is prepended
 * to the agent's context on every session, so it should orient and stop.
 */
const INSTRUCTIONS = `Ratel Cloud: agent context-usage analytics.

Each tool reads or changes one thing about a project. Call whoami first to learn
which project this credential reaches; most tools default to it.

Results are summarized with row caps. When one sets "truncated": true, narrow the
time window or filters rather than paging blindly. Every surface is on for every
organization, so an empty result means empty, not switched off.

Metrics come from two pipelines and each result names its own "source". Ask the
span tools about latency, errors and individual requests; ask get_cost_by_day and
get_cost_by_tool about tokens and cost, since those are the figures the customer
sees on their own dashboard. Do not add totals from the two together.

Tools that change something say so in their description.`;

const WHOAMI_DESCRIPTION = `Identify the credential calling this server: which project and organization it can reach. Call this first, since most tools act on a project and this tells you which one you have.`;

export interface McpServerDeps {
  auth: McpAuthContext;
  registry: Registry;
  /** Resolves the display identity for `whoami`. */
  describeCaller: (auth: McpAuthContext) => Promise<unknown>;
  /** Resolves a project's owning organization, for OAuth membership checks. */
  projectOwner?: DispatchDeps["projectOwner"];
  onOutcome?: DispatchDeps["onOutcome"];
  /**
   * Whether the improvement-loop tools are on for this request (`FF_MCP_LOOP`).
   * Only then do tools carry their loop stage as `_meta`; off, every tool is
   * listed exactly as before.
   */
  includeLoop?: boolean;
}

function asToolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Annotations let a client warn before running something that changes state,
 * and let it parallelize reads. Derived from the operation's own `mutates`
 * declaration so the two cannot disagree.
 */
function annotationsFor(operation: McpOperation) {
  return operation.mutates
    ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    : { readOnlyHint: true };
}

/**
 * Expose every operation as its own MCP tool.
 *
 * An earlier revision put three meta-tools in front of the registry and made
 * the agent discover operations at runtime. That is the right shape for a large
 * federated catalog, which is the problem Ratel solves for customers, but it is
 * the wrong shape here: thirty-one tools is an ordinary number that every MCP
 * client renders in a tool picker and every model is trained to choose from.
 * The indirection cost a round trip per call, hid the surface behind three
 * opaque verbs, and asked a customer to learn Ratel's retrieval model before
 * they could read their own traces.
 *
 * The registry stays: it is what makes the contract test and a single dispatch
 * pipeline possible. Only the façade changed, which is why this swap touched
 * one file.
 */
export function createRatelMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: WHOAMI_DESCRIPTION,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const identity = await deps.describeCaller(deps.auth);
      return asToolResult({ ok: true, ...(identity as Record<string, unknown>) });
    },
  );

  for (const operation of deps.registry.values()) {
    server.registerTool(
      operation.id,
      {
        title: operation.title,
        description: operation.description,
        inputSchema: operation.params,
        annotations: annotationsFor(operation),
        // With the loop on, each staged tool (existing ones included) publishes its
        // loop stage from lib/mcp/stages.ts. With it off no tool has _meta, as before.
        ...(deps.includeLoop && TOOL_STAGES[operation.id]
          ? { _meta: stageMeta(operation.id) }
          : {}),
      },
      async (args: Record<string, unknown>) => {
        // Params are re-validated inside dispatch. The SDK has already checked
        // them against the same schema, but dispatch is also the seam the tests
        // and any future transport go through, so it stays authoritative.
        const result = await dispatchOperation(operation.id, args ?? {}, {
          registry: deps.registry,
          auth: deps.auth,
          projectOwner: deps.projectOwner,
          onOutcome: deps.onOutcome,
        });
        return asToolResult(result, !result.ok);
      },
    );
  }

  return server;
}
