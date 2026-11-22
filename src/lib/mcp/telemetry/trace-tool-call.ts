import { type Span, SpanKind, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_MCP_METHOD_NAME,
  ATTR_MCP_SESSION_ID,
} from "@opentelemetry/semantic-conventions/incubating";
import {
  EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_NAME,
} from "@ratel-ai/telemetry";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { isStatementTimeout, McpOperationError } from "@/lib/mcp/errors";
import { getLogger } from "@/lib/platform/logger";
import { MCP_TOOL_TRACER } from "./export";
import { mcpClientName, mcpCredentialId, mcpSessionId } from "./session";

/**
 * One MCP tool call as one `execute_tool` span, the span the Ratel SDK makes
 * for a customer's tool (`traceExecuteTool`), named and keyed by the
 * `@ratel-ai/telemetry` vocabulary.
 *
 * Built here rather than through the SDK: `traceExecuteTool` is not exported by
 * `@ratel-ai/sdk` 0.13.0-rc.9 (only through a `ToolCatalog`), its tracer is the
 * SDK's own (so the export could not tell these spans from a customer's
 * Playground spans).
 *
 * Each span carries the call's arguments and result, capped at
 * `MAX_CONTENT_CHARS`. It is exported only when
 * `RATEL_SELF_TELEMETRY_MCP_API_KEY` holds a key (./export.ts).
 *
 * The span is a root and is never made active: the request's own spans
 * (Postgres, HTTP) keep their parent in the self-telemetry traces, and each tool call is its own
 * trace in the MCP project, grouped by `mcp.session.id`.
 */

export interface McpToolCall {
  toolName: string;
  /** The validated params, recorded as the span's tool arguments. */
  args: unknown;
  auth: McpAuthContext;
  projectId: string;
  organizationId: string | null;
}

export interface McpToolTelemetryDeps {
  requestHeaders: () => Promise<Pick<Headers, "get"> | null>;
  tracer: () => Tracer;
  now: () => number;
}

export const ORGANIZATION_ID_ATTRIBUTE = "ratel.cloud.organization_id";
export const PROJECT_ID_ATTRIBUTE = "ratel.cloud.project_id";

/** Tool args and results can be whole trace pages; the span keeps the start. */
const MAX_CONTENT_CHARS = 32_768;
const TOOLS_CALL = "tools/call";

const logger = getLogger("mcp-telemetry");

export const defaultMcpToolTelemetryDeps: McpToolTelemetryDeps = {
  requestHeaders: async () => {
    const { headers } = await import("next/headers");
    return headers();
  },
  tracer: () => trace.getTracer(MCP_TOOL_TRACER),
  now: Date.now,
};

/** Run one tool call inside its span. Telemetry never fails the call. */
export async function traceMcpToolCall<T extends { data: unknown }>(
  call: McpToolCall,
  run: () => Promise<T>,
  deps: McpToolTelemetryDeps = defaultMcpToolTelemetryDeps,
): Promise<T> {
  const span = await startToolSpan(call, deps);
  if (!span) return run();

  try {
    const result = await run();
    span.setAttribute(GEN_AI_TOOL_CALL_RESULT, contentOf(result.data));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    // The type only: an internal error's text can carry SQL and other tenants' ids.
    span.setAttribute(ATTR_ERROR_TYPE, errorType(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

async function startToolSpan(call: McpToolCall, deps: McpToolTelemetryDeps): Promise<Span | null> {
  // No project (an OAuth caller's list_projects): nothing to file the span under.
  if (!call.projectId) return null;
  try {
    const headers = await readHeaders(deps);
    const client = mcpClientName(headers);
    const session = mcpSessionId(headers, mcpCredentialId(call.auth), client, deps.now());

    return deps.tracer().startSpan(`${EXECUTE_TOOL} ${call.toolName}`, {
      kind: SpanKind.SERVER,
      root: true,
      attributes: {
        [GEN_AI_OPERATION_NAME]: EXECUTE_TOOL,
        [GEN_AI_TOOL_NAME]: call.toolName,
        [ATTR_MCP_METHOD_NAME]: TOOLS_CALL,
        [ATTR_MCP_SESSION_ID]: session.id,
        [ATTR_GEN_AI_AGENT_NAME]: client,
        [PROJECT_ID_ATTRIBUTE]: call.projectId,
        ...(call.organizationId ? { [ORGANIZATION_ID_ATTRIBUTE]: call.organizationId } : {}),
        [GEN_AI_TOOL_CALL_ARGUMENTS]: contentOf(call.args),
      },
    });
  } catch (error) {
    logger.warn({ err: error, tool: call.toolName }, "mcp tool span not started");
    return null;
  }
}

/** The request's headers, or none outside a request (a test, a direct dispatch). */
async function readHeaders(deps: McpToolTelemetryDeps): Promise<Pick<Headers, "get"> | null> {
  try {
    return await deps.requestHeaders();
  } catch (error) {
    logger.debug({ err: error }, "mcp request headers unavailable");
    return null;
  }
}

function errorType(error: unknown): string {
  if (error instanceof McpOperationError) return error.code;
  if (isStatementTimeout(error)) return "timeout";
  return "internal";
}

function contentOf(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    json = '"[unserializable]"';
  }
  return json.length > MAX_CONTENT_CHARS ? json.slice(0, MAX_CONTENT_CHARS) : json;
}
