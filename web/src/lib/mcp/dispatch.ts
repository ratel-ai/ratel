import type { Logger } from "pino";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { authOrganizationId, membershipFor } from "@/lib/mcp/auth";
import {
  forbidden,
  invalidParams,
  isStatementTimeout,
  type McpErrorBody,
  McpOperationError,
  notFound,
  timeout,
  unknownOperation,
} from "@/lib/mcp/errors";
import type { McpOperation, OperationResult, Registry } from "@/lib/mcp/registry";
import { traceMcpToolCall } from "@/lib/mcp/telemetry/trace-tool-call";
import { apiKeyPolicy } from "@/lib/platform/api-keys/policy";
import { mcpOperationScope } from "@/lib/platform/api-keys/routes";
import { missingScopeMessage } from "@/lib/platform/api-keys/scopes";
import { getLogger } from "@/lib/platform/logger";
import { organizationOnHold, projectOnHold } from "@/lib/platform/org-hold/state";

export interface DispatchSuccess {
  ok: true;
  operation_id: string;
  data: unknown;
  truncated?: boolean;
  window?: { since: string; until: string };
  hint?: string;
  /** OperationResult.view; the server moves it to the result's _meta (lib/mcp/server.ts asToolResult). */
  view?: Record<string, unknown>;
}

export type DispatchResult = DispatchSuccess | McpErrorBody;

export interface DispatchDeps {
  registry: Registry;
  auth: McpAuthContext;
  logger?: Logger;
  /** Emitted once per dispatch, success or failure. */
  /** Resolves a project's owning organization, for OAuth membership checks. */
  projectOwner?: ProjectOwnerLookup;
  onOutcome?: (outcome: {
    operationId: string;
    code: "ok" | McpErrorBody["error"];
    durationMs: number;
    mutates: boolean;
    truncated: boolean;
  }) => void;
  now?: () => number;
  /** Whether the project or organization is on hold; absent, the stored holds. */
  onHold?: (scope: ResolvedScope, auth: McpAuthContext) => Promise<boolean>;
  /** The result renders in an MCP Apps view (OperationContext.forView). */
  forView?: boolean;
}

/**
 * Resolve and authorize the project an operation will act on.
 *
 * An API key is bound to exactly one project, so an omitted `projectId` is
 * filled in and a *different* one is refused rather than quietly redirected.
 * Silently retargeting would hand an agent data it did not ask for and cannot
 * tell apart from what it did.
 */
export interface ResolvedScope {
  projectId: string;
  organizationId: string | null;
}

/**
 * Which organization owns a project. Injected so dispatch stays testable and so
 * the lookup happens once per call rather than inside each operation.
 */
export type ProjectOwnerLookup = (projectId: string) => Promise<{ organizationId: string } | null>;

export function resolveScope(
  auth: McpAuthContext,
  operation: McpOperation,
  requested: string | undefined,
): ResolvedScope {
  if (operation.scope === "none") {
    return { projectId: "", organizationId: authOrganizationId(auth) };
  }

  if (auth.kind === "api-key") {
    if (requested && requested !== auth.projectId) {
      throw forbidden(
        "This API key is scoped to a single project. Omit projectId, or use a key for the project you meant.",
      );
    }
    return { projectId: auth.projectId, organizationId: authOrganizationId(auth) };
  }

  // OAuth callers reach many projects, so the target is never implicit.
  if (!requested) {
    throw invalidParams(
      "projectId is required for this operation. Call list_projects to see the projects you can reach.",
    );
  }
  // Membership is checked in `authorizeProject`, which needs a lookup and so
  // cannot run here; this returns the request's intent, not its authorization.
  return { projectId: requested, organizationId: null };
}

/**
 * Confirm an OAuth caller may act on the project they named.
 *
 * A token proves identity, never access. Both "no such project" and "a project
 * in an organization you are not a member of" return `not_found`: telling them
 * apart would turn this into an id-enumeration oracle, letting anyone with a
 * valid login probe which UUIDs exist across other tenants.
 */
export async function authorizeProject(
  auth: McpAuthContext,
  scope: ResolvedScope,
  lookup: ProjectOwnerLookup,
): Promise<ResolvedScope> {
  if (auth.kind !== "oauth" || !scope.projectId) return scope;

  const owner = await lookup(scope.projectId);
  if (!owner) throw notFound("project");

  const membership = membershipFor(auth, owner.organizationId);
  if (!membership) throw notFound("project");

  return { projectId: scope.projectId, organizationId: owner.organizationId };
}

async function scopeOnHold(scope: ResolvedScope, auth: McpAuthContext): Promise<boolean> {
  const organizationId = scope.organizationId ?? authOrganizationId(auth);
  if (organizationId !== null && (await organizationOnHold(organizationId))) return true;
  return scope.projectId
    ? projectOnHold({ id: scope.projectId, organizationId: organizationId ?? "" })
    : false;
}

export async function dispatchOperation(
  operationId: string,
  rawParams: unknown,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const logger = deps.logger ?? getLogger("mcp");
  const operation = deps.registry.get(operationId);

  const finish = (result: DispatchResult): DispatchResult => {
    deps.onOutcome?.({
      operationId,
      code: result.ok ? "ok" : result.error,
      durationMs: now() - startedAt,
      mutates: operation?.mutates ?? false,
      truncated: result.ok ? result.truncated === true : false,
    });
    return result;
  };

  if (!operation) {
    // Unreachable through MCP: every tool is registered from this same
    // registry, so the transport rejects an unknown name before dispatch sees
    // it. Kept as a guard for direct callers (tests, any future transport).
    return finish(unknownOperation(operationId).toBody());
  }

  try {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    const requestedProjectId = typeof params.projectId === "string" ? params.projectId : undefined;
    // An API key reaches only the tools its scopes allow (RC-585): reading
    // tools need `mcp:read`, changing ones `mcp:write`. Checked before the
    // project is resolved, so a refusal reveals nothing about it.
    if (deps.auth.kind === "api-key") {
      const policy = apiKeyPolicy(deps.auth.scopes);
      for (const needed of [mcpOperationScope(operation), operation.apiKeyScope]) {
        if (needed && !policy.allows(needed)) throw forbidden(missingScopeMessage(needed));
      }
    }
    let scope = resolveScope(deps.auth, operation, requestedProjectId);
    if (deps.projectOwner) {
      scope = await authorizeProject(deps.auth, scope, deps.projectOwner);
    }

    // On hold until it opens (lib/platform/org-hold): a project key may read, nobody else may call.
    if (
      (operation.mutates || deps.auth.kind === "oauth") &&
      (await (deps.onHold ?? scopeOnHold)(scope, deps.auth))
    ) {
      throw new McpOperationError("unavailable", "This workspace is not open yet.", {
        reason: "on_hold",
      });
    }

    const parsed = operation.params.safeParse(params);
    if (!parsed.success) {
      return finish(
        invalidParams(
          "One or more parameters are invalid.",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ).toBody(),
      );
    }

    const call = {
      toolName: operation.id,
      args: withoutSecrets(parsed.data, operation.secretParams),
      auth: deps.auth,
      ...scope,
    };
    const result: OperationResult = await traceMcpToolCall(call, () =>
      operation.execute(
        {
          auth: deps.auth,
          projectId: scope.projectId,
          organizationId: scope.organizationId,
          logger,
          ...(deps.forView ? { forView: true } : {}),
        },
        parsed.data,
      ),
    );

    return finish({
      ok: true,
      operation_id: operation.id,
      data: result.data,
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.window ? { window: result.window } : {}),
      ...(result.hint ? { hint: result.hint } : {}),
      ...(deps.forView && result.view ? { view: result.view } : {}),
    });
  } catch (error) {
    if (error instanceof McpOperationError) return finish(error.toBody());
    if (isStatementTimeout(error)) return finish(timeout().toBody());

    // Never surface an internal failure's text: it can carry SQL fragments and
    // identifiers from other tenants. Log it with full context instead.
    logger.error({ err: error, operation_id: operation.id }, "mcp operation failed");
    return finish(
      new McpOperationError(
        "internal",
        "The operation failed unexpectedly. The error has been logged.",
      ).toBody(),
    );
  }
}

/** The args as telemetry records them. */
function withoutSecrets(
  args: Record<string, unknown>,
  secretParams: readonly string[] = [],
): Record<string, unknown> {
  const held = secretParams.filter((name) => args[name] !== undefined);
  return held.length === 0
    ? args
    : { ...args, ...Object.fromEntries(held.map((name) => [name, "[secret]"])) };
}
