import {
  type ResolvedApiKeyProject,
  resolveProjectFromBearer,
} from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { setRequestLogContext } from "@/lib/platform/request-log";
import { sandboxesEnabledForProject } from "@/lib/platform/sandboxes-flag";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { MIN_TOKEN_SECRET_LENGTH, signSandboxToken } from "./domain/token";

/**
 * `POST /api/v1/runner/connect` (RC-1097): a `ratel sandbox dev` runner trades its
 * project key for a 15-minute socket token and the gateway URL. The token names
 * the project, its organization, the key and the owner: the key's creator. A
 * run goes only to its owner's runner, so a key that does not record its
 * creator, or a publishable (ingest-only) key that anyone may hold, gets none.
 */

export interface RunnerConnectDeps {
  resolveKey: (req: Request, scope: ApiKeyScope) => Promise<ResolvedApiKeyProject>;
  organizationIdOf: (projectId: string) => Promise<string | null>;
  sandboxesEnabled: (projectId: string) => Promise<boolean>;
  tokenSecret: () => string | undefined;
  gatewayUrl: () => string | undefined;
  now: () => Date;
  trackConnected: (
    context: { projectId: string; orgId: string },
    properties: Record<string, unknown>,
  ) => Promise<void>;
}

const logger = getLogger("sandboxes/connect");

export const defaultRunnerConnectDeps: RunnerConnectDeps = {
  resolveKey: (req, scope) => resolveProjectFromBearer(req, scope),
  organizationIdOf: async (projectId) => (await getOrganizationByProjectId(projectId))?.id ?? null,
  sandboxesEnabled: (projectId) => sandboxesEnabledForProject(projectId),
  tokenSecret: () => process.env.SANDBOX_GATEWAY_TOKEN_SECRET,
  gatewayUrl: () => process.env.SANDBOX_GATEWAY_URL,
  now: () => new Date(),
  trackConnected: (context, properties) =>
    trackServerEvent("sandbox_runner_connected", context, properties),
};

export async function handleRunnerConnect(
  req: Request,
  scope: ApiKeyScope,
  deps: RunnerConnectDeps = defaultRunnerConnectDeps,
): Promise<Response> {
  const key = await deps.resolveKey(req, scope);
  if (!key.ok) return key.response;
  setRequestLogContext(req, { project_id: key.projectId });

  const organizationId = await deps.organizationIdOf(key.projectId);
  if (!organizationId || !(await deps.sandboxesEnabled(key.projectId))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (key.policy.publishable) {
    return Response.json(
      {
        error: "forbidden",
        reason: "publishable_key",
        message: "Use a secret project key: an ingest-only key cannot connect a runner.",
      },
      { status: 403 },
    );
  }
  if (!key.createdBy) {
    return Response.json(
      {
        error: "forbidden",
        reason: "key_without_owner",
        message: "Create a new project key: this key does not record who created it.",
      },
      { status: 403 },
    );
  }

  const secret = deps.tokenSecret();
  const gatewayUrl = deps.gatewayUrl();
  if (!secret || secret.length < MIN_TOKEN_SECRET_LENGTH || !gatewayUrl) {
    logger.error(
      {
        project_id: key.projectId,
        has_secret: Boolean(secret),
        has_gateway_url: Boolean(gatewayUrl),
      },
      "refused runner connect without gateway config",
    );
    return Response.json(
      { error: "unavailable", message: "The runner gateway is not configured." },
      { status: 503 },
    );
  }

  const { token, expiresAt } = signSandboxToken(
    {
      projectId: key.projectId,
      organizationId,
      ownerUserId: key.createdBy,
      apiKeyId: key.apiKeyId,
    },
    secret,
    deps.now(),
  );
  await deps.trackConnected(
    { projectId: key.projectId, orgId: organizationId },
    { api_key_id: key.apiKeyId },
  );
  // projectId lets `ratel sandbox dev` print the playground link of each sandbox.
  return Response.json({
    gatewayUrl,
    token,
    expiresAt: expiresAt.toISOString(),
    projectId: key.projectId,
  });
}
