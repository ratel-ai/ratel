import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpAppCatalog } from "@/lib/mcp/apps/catalog";
import {
  BINDING_META_KEY,
  MCP_APP_MIME_TYPE,
  mcpAppUri,
  VIEW_META_KEY,
} from "@/lib/mcp/apps/types";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { type DispatchDeps, dispatchOperation } from "@/lib/mcp/dispatch";
import type { McpOperation, Registry } from "@/lib/mcp/registry";
import { stageMeta, toolStage } from "@/lib/mcp/stages";
import { productName, productSlug } from "@/lib/platform/product-name";

/** The server is named by `productSlug()`: "ratel", or the edition's slug. */
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * How the model is told to use this server. Deliberately short: it is prepended
 * to the agent's context on every session, so it should orient and stop. It
 * opens with the edition's product name ("Ratel"), "Ratel" without one.
 */
const INSTRUCTIONS_BODY = `agent context-usage analytics.

Each tool reads or changes one thing about a project. whoami names the project
this credential reaches; most tools default to it.

Results are summarized with row caps. When one sets "truncated": true, narrow the
time window or filters, or follow the cursor a list returns. An empty result
means empty; a surface that is switched off for this caller refuses with
"forbidden" and says which, and get_flag_status lists what is on.

Metrics come from two pipelines and each result names its own "source". Ask the
span tools about latency, errors and individual requests; ask get_cost_by_day and
get_cost_by_tool about tokens and cost, since those are the figures the customer
sees on their own dashboard. Do not add totals from the two together.

Tools that change something say so in their description.`;

/**
 * Added to the instructions with `mcpApps` on, for a client that shows views
 * (lib/mcp/apps/client-views.ts). Plain, not hedged: a hedged line ("where the
 * client supports…") left the model unsure and it restated every row (RW-54).
 */
export const VIEW_INSTRUCTIONS = `This client shows tool results as interactive views. When a result says the
person is looking at it as a view, they already see its data: reply in one or
two lines with the takeaway, and do not list its rows, spans or tables or repeat
its numbers.`;

/**
 * The one line a bound tool's success adds for a client that shows views, as a
 * second text block: the first block and structuredContent stay byte-identical
 * to the server without views.
 */
export function viewHint(title: string): string {
  return `The person is looking at this result as Ratel's ${title} view. Reply in one or two lines with the takeaway; do not list its rows or repeat its numbers.`;
}

const WHOAMI_TITLE = "Who am I";
const WHOAMI_DESCRIPTION = `Identify the credential calling this server: which project and organization it can reach. Most tools act on a project, and this tells you which one you have.`;

export interface McpServerDeps {
  auth: McpAuthContext;
  registry: Registry;
  /** Resolves the display identity for `whoami`. */
  describeCaller: (auth: McpAuthContext) => Promise<unknown>;
  /** Resolves a project's owning organization, for OAuth membership checks. */
  projectOwner?: DispatchDeps["projectOwner"];
  onOutcome?: DispatchDeps["onOutcome"];
  /**
   * The MCP Apps views to publish (`mcpApps`). Absent, the server
   * declares no resources and no tool carries a view: exactly the server
   * without the flag.
   */
  apps?: McpAppCatalog;
  /**
   * This app's public origin, written into each view so its console links
   * open here (a local run links to localhost, staging to staging). Absent,
   * views link to the hosted console (mcp-apps/shell/links.ts CONSOLE_ORIGIN).
   */
  consoleOrigin?: string;
  /**
   * The client shows views (it declared the MCP Apps extension). Only then do
   * the instructions and each bound tool's result tell the model that the
   * person already sees the data; a client without views reads what main sends.
   */
  clientRendersViews?: boolean;
}

/**
 * A dispatch result as an MCP tool result. Its `view` (data only a view reads,
 * OperationResult.view) goes into `_meta["sh.ratel/view"]` alone: hosts give
 * the model content and structuredContent, so both stay byte-identical to the
 * server without views, and the view reads its model from `_meta`.
 */
export function asToolResult(
  payload: unknown,
  isError = false,
  meta?: Record<string, unknown>,
  hint?: string,
) {
  const { view, ...body } = (payload ?? {}) as Record<string, unknown>;
  const resultMeta = view === undefined ? meta : { ...meta, [VIEW_META_KEY]: view };
  const text = { type: "text" as const, text: JSON.stringify(body, null, 2) };
  return {
    content: hint && !isError ? [text, { type: "text" as const, text: hint }] : [text],
    structuredContent: body,
    ...(isError ? { isError: true } : {}),
    ...(resultMeta ? { _meta: resultMeta } : {}),
  };
}

/**
 * A tool's `_meta`: its loop stage (lib/mcp/stages.ts) and, when it is bound
 * to a view, `ui.resourceUri` (MCP Apps). Undefined when there is neither, so
 * an unbound tool is listed exactly as before.
 */
function toolMeta(
  toolId: string,
  apps: McpAppCatalog | undefined,
  appOnly = false,
): Record<string, unknown> | undefined {
  const stage = toolStage(toolId) ? stageMeta(toolId) : undefined;
  if (appOnly) return { ...stage, ui: { visibility: ["app"] } };
  const bound = apps?.boundTool(toolId);
  if (!bound) return stage;
  return { ...stage, ui: { resourceUri: bound.uri } };
}

/** The line a bound tool's result tells the model, naming the view it renders in. */
function resultHint(toolId: string, apps: McpAppCatalog | undefined): string | undefined {
  const bound = apps?.boundTool(toolId);
  if (!bound) return undefined;
  const title = apps!.views.find((view) => view.view === bound.view)?.title ?? bound.view;
  return viewHint(title);
}

/** Which binding a bound tool's result renders with; see lib/mcp/apps/README.md. */
function resultMeta(
  toolId: string,
  apps: McpAppCatalog | undefined,
): Record<string, unknown> | undefined {
  const bound = apps?.boundTool(toolId);
  return bound ? { [BINDING_META_KEY]: { view: bound.view, tool: toolId } } : undefined;
}

/**
 * Publish each view as a `ui://ratel/<view>` resource. Registering one is what
 * makes the SDK answer resources/list and resources/read and declare the
 * resources capability; with no views none of that happens.
 */
function registerViews(
  server: McpServer,
  apps: McpAppCatalog,
  consoleOrigin: string | undefined,
): void {
  for (const view of apps.views) {
    const uri = mcpAppUri(view.view);
    server.registerResource(
      view.view,
      uri,
      {
        title: view.title ?? view.view,
        ...(view.description ? { description: view.description } : {}),
        mimeType: MCP_APP_MIME_TYPE,
      },
      async () => ({
        contents: [
          { uri, mimeType: MCP_APP_MIME_TYPE, text: withConsoleOrigin(view.html, consoleOrigin) },
        ],
      }),
    );
  }
}

/** The name of the <meta> a view reads its console origin from (mcp-apps/shell/links.ts). */
export const CONSOLE_ORIGIN_META = "ratel-console-origin";

/** A view's HTML with this app's origin in its head, for its console links. */
export function withConsoleOrigin(html: string, origin: string | undefined): string {
  if (!origin) return html;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return html;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return html;
  const tag = `<meta name="${CONSOLE_ORIGIN_META}" content="${parsed.origin}">`;
  return html.includes("<head>") ? html.replace("<head>", `<head>${tag}`) : `${tag}${html}`;
}

/**
 * Annotations let a client warn before running something that changes state,
 * and let it parallelize reads. Derived from the operation's own `mutates`
 * declaration so the two cannot disagree.
 *
 * Every write sets `destructiveHint`: the Claude directory asks for it on each
 * tool that modifies or deletes data, and Claude prompts before running one.
 */
function annotationsFor(operation: McpOperation) {
  return operation.mutates
    ? { title: operation.title, readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    : { title: operation.title, readOnlyHint: true };
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
  const shownAsViews =
    deps.clientRendersViews === true && deps.apps !== undefined && deps.apps.views.length > 0;
  const hintFor = (toolId: string) => (shownAsViews ? resultHint(toolId, deps.apps) : undefined);
  const server = new McpServer(
    { name: productSlug(), version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: shownAsViews
        ? `${productName()}: ${INSTRUCTIONS_BODY}\n\n${VIEW_INSTRUCTIONS}`
        : `${productName()}: ${INSTRUCTIONS_BODY}`,
    },
  );

  const whoamiMeta = toolMeta("whoami", deps.apps);
  server.registerTool(
    "whoami",
    {
      title: WHOAMI_TITLE,
      description: WHOAMI_DESCRIPTION,
      inputSchema: z.object({}),
      annotations: { title: WHOAMI_TITLE, readOnlyHint: true },
      ...(whoamiMeta ? { _meta: whoamiMeta } : {}),
    },
    async () => {
      const identity = await deps.describeCaller(deps.auth);
      return asToolResult(
        { ok: true, ...(identity as Record<string, unknown>) },
        false,
        resultMeta("whoami", deps.apps),
        hintFor("whoami"),
      );
    },
  );

  for (const operation of deps.registry.values()) {
    if (operation.appOnly && !deps.apps?.views.length) continue;
    const meta = toolMeta(operation.id, deps.apps, operation.appOnly);
    server.registerTool(
      operation.id,
      {
        title: operation.title,
        description: operation.description,
        inputSchema: operation.params,
        annotations: annotationsFor(operation),
        // Each staged tool publishes its loop stage from lib/mcp/stages.ts,
        // and a tool bound to a view its ui.resourceUri (lib/mcp/apps).
        ...(meta ? { _meta: meta } : {}),
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
          // A view's own reads only for a client that shows views (lib/mcp/apps/client-views.ts).
          forView: shownAsViews && deps.apps?.boundTool(operation.id) !== undefined,
        });
        return asToolResult(
          result,
          !result.ok,
          resultMeta(operation.id, deps.apps),
          hintFor(operation.id),
        );
      },
    );
  }

  if (deps.apps && deps.apps.views.length > 0) registerViews(server, deps.apps, deps.consoleOrigin);

  return server;
}
