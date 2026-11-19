"use server";

import { revalidatePath } from "next/cache";
import {
  type ApiKeyActionContextResult,
  type ApiKeyActionDeps,
  type CreateApiKeyInput,
  type CreateApiKeyState,
  createApiKeyHandler,
  type RevokeApiKeyState,
  revokeApiKeyHandler,
} from "@/lib/platform/api-key-actions";
import { keepApiKeySecret } from "@/lib/platform/api-key-secrets";
import { generateApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import {
  createApiKey,
  findApiKeyForProject,
  getProjectBySlug,
  listApiKeysForProject,
  revokeApiKey,
} from "@/lib/platform/projects/queries";
import { getSessionContext, sessionForOrganization } from "@/lib/platform/session";
import { supportSessionActingAs } from "@/lib/platform/support-session";
import { trackProductEvent } from "@/lib/platform/telemetry";

export type {
  ApiKeySummary,
  CreateApiKeyState,
  RevokeApiKeyState,
} from "@/lib/platform/api-key-actions";

const logger = getLogger("settings/api-keys");

const apiKeyActionDeps: ApiKeyActionDeps = {
  isDbConfigured,
  getContext: getApiKeyActionContext,
  actingAs: () => supportSessionActingAs(),
  getProjectBySlug,
  listApiKeysForProject,
  findApiKeyForProject,
  generateApiKey,
  createApiKey,
  revokeApiKey,
  keepApiKeySecret,
  trackApiKeyCreated: async (ctx, projectId, details) => {
    await trackProductEvent(
      "api_key_created",
      { externalId: ctx.user.externalId, orgId: ctx.organization.id, projectId },
      {
        key_prefix: details.keyPrefix,
        named: details.named,
        expires_in: details.expiresIn,
        access: details.access,
      },
    );
  },
  trackApiKeyRevoked: async (ctx, projectId, details) => {
    await trackProductEvent(
      "api_key_revoked",
      { externalId: ctx.user.externalId, orgId: ctx.organization.id, projectId },
      { key_prefix: details.keyPrefix },
    );
  },
  logInfo: (fields, message) => logger.info(fields, message),
  revalidatePath,
  now: () => new Date(),
};

/** Issue an additional API key for a project, optionally named and with an expiry. */
export async function createApiKeyAction(
  input: CreateApiKeyInput,
  organizationId?: string,
): Promise<CreateApiKeyState> {
  return createApiKeyHandler(input, organizationId, apiKeyActionDeps);
}

/** Take one of a project's keys out of service, leaving the others live. */
export async function revokeApiKeyAction(
  input: { projectSlug: string; keyId: string },
  organizationId?: string,
): Promise<RevokeApiKeyState> {
  return revokeApiKeyHandler(input, organizationId, apiKeyActionDeps);
}

/** Any organization the reader belongs to, as upstream; an id naming any other one resolves to nothing. */
async function getApiKeyActionContext(organizationId?: string): Promise<ApiKeyActionContextResult> {
  const session = await getSessionContext();
  if (!session) return { ok: false, error: "Your session has expired. Sign in again." };
  const ctx = sessionForOrganization(session, organizationId);
  if (!ctx) return { ok: false, error: "Organization not found." };
  return { ok: true, context: { user: ctx.user, organization: ctx.organization } };
}
