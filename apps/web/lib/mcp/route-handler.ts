import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  authDistinctId,
  authenticateMcpRequest,
  authOrganizationId,
  type McpAuthContext,
} from "@/lib/mcp/auth";
import { clientAddress } from "@/lib/mcp/client-address";
import { type McpErrorCode, McpOperationError } from "@/lib/mcp/errors";
import { buildRequestRegistry } from "@/lib/mcp/operations";
import { describeCaller } from "@/lib/mcp/operations/scope";
import { mcpResourceMetadataUrl } from "@/lib/mcp/public-origin";
import { createRatelMcpServer } from "@/lib/mcp/server";
import { SingleMessageTransport } from "@/lib/mcp/transport";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import { getLogger } from "@/lib/platform/logger";
import { getProjectById } from "@/lib/platform/projects/queries";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import { setRequestLogContext } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

const logger = getLogger("mcp");

/**
 * One MCP POST is one tool call, so this is generous for an agent loop while
 * still capping a retry storm.
 *
 * Every bucket in this file is process-local, and the service autoscales to
 * three tasks in production behind an ALB with no session affinity. The real
 * ceiling a caller can reach is therefore this number times the running task
 * count, not this number: treat these as a backstop against a runaway client,
 * never as a quota anyone is owed or held to. Making them exact would mean a
 * shared store on the hot path of every request, which costs more than the
 * imprecision does.
 */
const PER_KEY_LIMIT = { limitPerMinute: 60, burst: 120 };
const GLOBAL_LIMIT = { limitPerMinute: 600, burst: 900 };

/**
 * Failed credentials, budgeted per client address.
 *
 * Authentication is the first thing a request touches, and until now it ran
 * unmetered: the buckets above key on a credential, and a request that fails to
 * authenticate has no credential to key on. So the work of *rejecting* an
 * anonymous caller was free to that caller and not to us. An `rtl_` guess costs
 * a database lookup; anything else is treated as a Clerk token and costs an
 * outbound call to Clerk, against a third-party rate limit we do not control.
 * Either one was reachable by anyone on the internet, at any rate, with no
 * credential at all.
 *
 * Only failures are charged, so an address shared behind NAT is never penalised
 * for the volume of its legitimate traffic. A genuinely expired key costs a
 * handful of attempts while the client notices and re-authenticates, which this
 * leaves ample room for.
 */
const CREDENTIAL_FAILURE_LIMIT = { limitPerMinute: 20, burst: 40 };

/** Requests are JSON-RPC envelopes, not payloads. 256 KiB is already generous. */
const MAX_BODY_BYTES = 256 * 1024;

/** A stateless server has no reason to accept a batch large enough to amplify. */
const MAX_BATCH = 5;

export interface McpRouteDeps {
  authenticate: typeof authenticateMcpRequest;
  /** Charged only when a credential is rejected. See CREDENTIAL_FAILURE_LIMIT. */
  credentialLimiter: ReturnType<typeof createTokenBucketRateLimiter>;
  perKeyLimiter: ReturnType<typeof createTokenBucketRateLimiter>;
  globalLimiter: ReturnType<typeof createTokenBucketRateLimiter>;
  trackServerEvent: typeof trackServerEvent;
  now?: () => number;
}

export const defaultRouteDeps: McpRouteDeps = {
  authenticate: authenticateMcpRequest,
  credentialLimiter: createTokenBucketRateLimiter(CREDENTIAL_FAILURE_LIMIT),
  perKeyLimiter: createTokenBucketRateLimiter(PER_KEY_LIMIT),
  globalLimiter: createTokenBucketRateLimiter(GLOBAL_LIMIT),
  trackServerEvent,
};

/**
 * Record a refusal that happens before dispatch.
 *
 * Operation-level outcomes already emit `mcp_operation_denied` from dispatch,
 * but a request turned away at the door never reached dispatch and so counted
 * nowhere. That is the half of the picture rollout actually needs: a dashboard
 * that shows only the denials of callers who got in cannot tell you that an
 * organization is hammering a surface it has not been given, or that a client
 * is stuck in a retry loop. `stage` separates the two so they can be read
 * apart.
 */
function trackTransportDenial(
  deps: McpRouteDeps,
  auth: McpAuthContext,
  code: McpErrorCode,
  properties: Record<string, unknown> = {},
): void {
  const fields = { outcome: code, stage: "transport", ...properties };
  logger.warn(fields, "mcp request denied before dispatch");
  void deps.trackServerEvent(
    "mcp_operation_denied",
    auth.kind === "api-key" ? { projectId: auth.projectId } : { distinctId: auth.externalUserId },
    fields,
  );
}

function errorResponse(error: McpOperationError, status: number, request?: Request): Response {
  const body = error.toBody();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (body.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(body.retryAfterSeconds);
  }
  if (error.code === "unauthorized" && request) {
    // The link that turns a 401 into a browser consent screen. It has to point
    // at the origin the client actually used, or discovery walks off this
    // server and the client stalls with no browser ever opening.
    headers["www-authenticate"] =
      `Bearer realm="ratel-cloud", resource_metadata="${mcpResourceMetadataUrl(request)}"`;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const STATUS_BY_CODE: Partial<Record<McpOperationError["code"], number>> = {
  unauthorized: 401,
  rate_limited: 429,
  unavailable: 503,
  not_found: 404,
};

export function createMcpRouteHandler(deps: McpRouteDeps = defaultRouteDeps) {
  return async function handleMcpRequest(request: Request): Promise<Response> {
    // Checked before authentication runs, because authentication is the cost
    // being protected. Charged after, and only on failure, so the budget tracks
    // wrong credentials rather than traffic.
    const address = clientAddress(request);
    const credentialKey = `mcp:auth:${address}`;
    const credentialBudget = deps.credentialLimiter.peek(credentialKey);
    if (!credentialBudget.allowed) {
      logger.warn(
        {
          outcome: "rate_limited",
          stage: "transport",
          scope: "credential_attempts",
          client_address: address,
          retry_after_seconds: credentialBudget.retryAfterSeconds,
        },
        "mcp credential attempts rate limited",
      );
      return errorResponse(
        new McpOperationError(
          "rate_limited",
          "Too many failed authentication attempts from this address. Wait before retrying.",
          { retryAfterSeconds: credentialBudget.retryAfterSeconds },
        ),
        429,
        request,
      );
    }

    // Authentication decides, it does not throw. A credential problem is the
    // most ordinary thing that happens here, and a 500 tells a client nothing
    // it can act on: it will not re-authenticate, because a server error is not
    // its fault. Anything unexpected in this path is logged and reported as
    // unauthorized so the client does the one useful thing available to it.
    let auth: Awaited<ReturnType<typeof deps.authenticate>>;
    try {
      auth = await deps.authenticate(request);
    } catch (error) {
      // Charged like any other rejection: an input that reliably throws would
      // otherwise be the cheapest way to keep this path running unmetered.
      deps.credentialLimiter.consume(credentialKey);
      logger.error(
        { err: error, client_address: address },
        "mcp authentication failed unexpectedly",
      );
      return errorResponse(
        new McpOperationError(
          "unauthorized",
          "Could not verify the credential. Re-authenticate with your MCP client.",
        ),
        401,
        request,
      );
    }
    if (!auth.ok) {
      // Charged for a bad credential, not for our own unavailability. An
      // unconfigured database is refused before any lookup happens, so it costs
      // the caller nothing and must not spend their budget: doing so would
      // replace a message that explains the outage with one that blames them.
      if (auth.error.code === "unauthorized") {
        deps.credentialLimiter.consume(credentialKey);
      }
      // No typed event here on purpose: this is the one path an anonymous
      // caller can reach at will, and emitting an analytics event per attempt
      // would hand them an amplifier pointed at our own pipeline. The
      // structured log is enough to see a burst in CloudWatch.
      logger.warn(
        { outcome: auth.error.code, stage: "transport", client_address: address },
        "mcp credential rejected",
      );
      return errorResponse(auth.error, STATUS_BY_CODE[auth.error.code] ?? 400, request);
    }

    const distinctId = authDistinctId(auth.auth);
    const organizationId = authOrganizationId(auth.auth);
    setRequestLogContext(request, {
      ...(auth.auth.kind === "api-key" ? { project_id: auth.auth.projectId } : {}),
      ...(organizationId ? { org_id: organizationId } : {}),
      distinct_id: distinctId,
    });

    const rateKey =
      auth.auth.kind === "api-key" ? `mcp:${auth.auth.apiKeyId}` : `mcp:${distinctId}`;
    for (const [limiter, key, scope] of [
      [deps.perKeyLimiter, rateKey, "per_credential"],
      [deps.globalLimiter, "mcp:global", "process_wide"],
    ] as const) {
      const decision = limiter.consume(key);
      if (!decision.allowed) {
        trackTransportDenial(deps, auth.auth, "rate_limited", {
          scope,
          retry_after_seconds: decision.retryAfterSeconds,
        });
        return errorResponse(
          new McpOperationError("rate_limited", "Too many requests. Slow down and retry.", {
            retryAfterSeconds: decision.retryAfterSeconds,
          }),
          429,
          request,
        );
      }
    }

    const body = await readBodyWithCap(request, MAX_BODY_BYTES);
    if (!body.ok) {
      trackTransportDenial(deps, auth.auth, "invalid_params", { reason: "body_too_large" });
      return errorResponse(
        new McpOperationError("invalid_params", "Request body too large."),
        413,
        request,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      // A malformed envelope is a JSON-RPC parse error, which has a reserved
      // code and no request id to correlate against.
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length > MAX_BATCH) {
      trackTransportDenial(deps, auth.auth, "invalid_params", {
        reason: "batch_too_large",
        batch_size: messages.length,
      });
      return errorResponse(
        new McpOperationError("invalid_params", `Batches are limited to ${MAX_BATCH} messages.`),
        400,
        request,
      );
    }

    const responses = await runMessages(messages as JSONRPCMessage[], auth.auth, deps);

    // Notifications produce nothing to return; the spec wants 202 with no body.
    if (responses.length === 0) return new Response(null, { status: 202 });

    return new Response(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function runMessages(
  messages: readonly JSONRPCMessage[],
  auth: McpAuthContext,
  deps: McpRouteDeps,
): Promise<JSONRPCMessage[]> {
  const registry = buildRequestRegistry();
  const server = createRatelMcpServer({
    auth,
    registry,
    describeCaller,
    projectOwner: async (projectId) => {
      const project = await getProjectById(projectId);
      return project ? { organizationId: project.organizationId } : null;
    },
    onOutcome: (outcome) => {
      const properties = {
        operation_id: outcome.operationId,
        outcome: outcome.code,
        duration_ms: outcome.durationMs,
        mutates: outcome.mutates,
        truncated: outcome.truncated,
      };
      logger.info(properties, "mcp operation executed");
      const context =
        auth.kind === "api-key"
          ? { projectId: auth.projectId }
          : { distinctId: auth.externalUserId };
      void deps.trackServerEvent(
        outcome.code === "ok" ? "mcp_operation_executed" : "mcp_operation_denied",
        context,
        properties,
      );
    },
  });

  const transport = new SingleMessageTransport();
  await server.connect(transport);
  try {
    const collected: JSONRPCMessage[] = [];
    for (const message of messages) {
      collected.push(...(await transport.handle(message)));
    }
    return collected;
  } finally {
    await server.close();
  }
}

/** GET and DELETE exist in Streamable HTTP only for server-initiated streams and
 * session teardown. This server is stateless and serves neither. */
export function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "method_not_allowed",
      message:
        "This MCP endpoint is stateless: POST JSON-RPC messages. It does not open SSE streams or hold sessions.",
    }),
    { status: 405, headers: { "content-type": "application/json", allow: "POST" } },
  );
}
