import {
  type ApiKeyExpiryPreset,
  type ApiKeyStatus,
  apiKeyStatus,
  DEFAULT_API_KEY_EXPIRY,
  type GeneratedApiKey,
  normalizeApiKeyName,
  resolveApiKeyExpiry,
} from "@/lib/platform/api-keys";

/**
 * Create/revoke logic for a project's API keys, split from the `"use server"` wrappers in
 * `app/(console)/project/[projectId]/settings/api-keys/actions.ts` so it can be unit-tested
 * without Next or a database.
 *
 * A project keeps as many live keys as it needs (one per environment or integration), so
 * creating never touches the keys already out there, and revoking takes exactly one key down.
 */

/** The shape the dashboard renders — no hashes, no plaintext. */
export type ApiKeySummary = {
  id: string;
  name: string | null;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  status: ApiKeyStatus;
};

/** The stored columns these handlers care about. */
export type ApiKeyRecord = {
  id: string;
  projectId: string;
  name: string | null;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
};

export type CreateApiKeyState =
  | { ok: true; plaintext: string; key: ApiKeySummary }
  | { ok: false; error: string };
export type RevokeApiKeyState = { ok: true; keyId: string } | { ok: false; error: string };

export type ApiKeyActionContext = {
  user: { externalId: string };
  organization: { id: string; slug: string };
};
export type ApiKeyActionContextResult =
  | { ok: true; context: ApiKeyActionContext }
  | { ok: false; error: string };

export type ApiKeyActionDeps = {
  isDbConfigured(): boolean;
  getContext(organizationId?: string): Promise<ApiKeyActionContextResult>;
  getProjectBySlug(organizationId: string, projectSlug: string): Promise<{ id: string } | null>;
  listApiKeysForProject(projectId: string): Promise<ApiKeyRecord[]>;
  findApiKeyForProject(projectId: string, keyId: string): Promise<ApiKeyRecord | null>;
  generateApiKey(): GeneratedApiKey;
  createApiKey(input: {
    projectId: string;
    name: string | null;
    keyHash: string;
    keyPrefix: string;
    expiresAt: Date | null;
  }): Promise<ApiKeyRecord>;
  revokeApiKey(keyId: string): Promise<void>;
  trackApiKeyCreated(
    context: ApiKeyActionContext,
    projectId: string,
    details: {
      keyPrefix: string;
      named: boolean;
      /** Which lifetime was picked — the distribution is the useful signal. */
      expiresIn: ApiKeyExpiryPreset;
    },
  ): Promise<void>;
  trackApiKeyRevoked(
    context: ApiKeyActionContext,
    projectId: string,
    details: { keyPrefix: string },
  ): Promise<void>;
  logInfo(fields: Record<string, unknown>, message: string): void;
  revalidatePath(path: string, type?: "layout"): void;
  now(): Date;
};

/**
 * How many unrevoked keys a project may hold. Generous enough for a key per
 * environment plus spares, low enough that a stuck form can't fill the table.
 */
export const MAX_API_KEYS_PER_PROJECT = 20;

const KEY_LIMIT_ERROR =
  `This project already has ${MAX_API_KEYS_PER_PROJECT} keys. ` +
  "Revoke one before creating another.";

export type CreateApiKeyInput = {
  projectSlug: string;
  name?: string | null;
  /**
   * One of the offered lifetimes. The server turns it into an instant, so the
   * client never gets to name the expiry date itself. Omitted means "never".
   */
  expiresIn?: ApiKeyExpiryPreset | null;
};

/**
 * Issue an additional key for the project. Every key already out there keeps working. The
 * plaintext comes back once, for the caller to copy; it's never returned again.
 */
export async function createApiKeyHandler(
  input: CreateApiKeyInput,
  organizationId: string | undefined,
  deps: ApiKeyActionDeps,
): Promise<CreateApiKeyState> {
  if (!deps.isDbConfigured()) {
    return { ok: false, error: "Database not connected." };
  }

  const result = await deps.getContext(organizationId);
  if (!result.ok) return result;
  const ctx = result.context;

  const project = await deps.getProjectBySlug(ctx.organization.id, input.projectSlug);
  if (!project) return { ok: false, error: "Project not found." };

  const name = normalizeApiKeyName(input.name);
  if (!name.ok) return name;
  const expiration = resolveApiKeyExpiry(input.expiresIn, deps.now());
  if (!expiration.ok) return expiration;

  const existing = await deps.listApiKeysForProject(project.id);
  if (existing.length >= MAX_API_KEYS_PER_PROJECT) {
    return { ok: false, error: KEY_LIMIT_ERROR };
  }

  const generated = deps.generateApiKey();
  const created = await deps.createApiKey({
    projectId: project.id,
    name: name.name,
    keyHash: generated.hash,
    keyPrefix: generated.prefix,
    expiresAt: expiration.expiresAt,
  });

  deps.logInfo(
    {
      apiKeyId: created.id,
      projectId: project.id,
      orgId: ctx.organization.id,
      keyPrefix: created.keyPrefix,
      expiresAt: expiration.expiresAt?.toISOString() ?? null,
    },
    "issued api key",
  );
  await deps.trackApiKeyCreated(ctx, project.id, {
    keyPrefix: created.keyPrefix,
    named: name.name !== null,
    expiresIn: input.expiresIn ?? DEFAULT_API_KEY_EXPIRY,
  });
  revalidateApiKeySurfaces(deps, project.id);

  return {
    ok: true,
    plaintext: generated.plaintext,
    key: toApiKeySummary(created, deps.now()),
  };
}

/**
 * Take a single key out of service. Scoped by project, so a key id guessed from
 * another organization resolves to nothing rather than being revoked.
 */
export async function revokeApiKeyHandler(
  input: { projectSlug: string; keyId: string },
  organizationId: string | undefined,
  deps: ApiKeyActionDeps,
): Promise<RevokeApiKeyState> {
  if (!deps.isDbConfigured()) {
    return { ok: false, error: "Database not connected." };
  }

  const result = await deps.getContext(organizationId);
  if (!result.ok) return result;
  const ctx = result.context;

  const project = await deps.getProjectBySlug(ctx.organization.id, input.projectSlug);
  if (!project) return { ok: false, error: "Project not found." };

  const key = await deps.findApiKeyForProject(project.id, input.keyId);
  if (!key) return { ok: false, error: "API key not found." };
  // Revoking twice is the same outcome, so report success rather than an error
  // the user can do nothing about (two tabs, or a double-click).
  if (key.revokedAt !== null) return { ok: true, keyId: key.id };

  await deps.revokeApiKey(key.id);

  deps.logInfo(
    {
      apiKeyId: key.id,
      projectId: project.id,
      orgId: ctx.organization.id,
      keyPrefix: key.keyPrefix,
    },
    "revoked api key",
  );
  await deps.trackApiKeyRevoked(ctx, project.id, { keyPrefix: key.keyPrefix });
  revalidateApiKeySurfaces(deps, project.id);

  return { ok: true, keyId: key.id };
}

/** Strip a stored key down to what the client may see, with its status resolved. */
export function toApiKeySummary(key: ApiKeyRecord, now: Date): ApiKeySummary {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    status: apiKeyStatus(key, now),
  };
}

function revalidateApiKeySurfaces(deps: ApiKeyActionDeps, projectId: string): void {
  deps.revalidatePath(`/project/${projectId}/settings/api-keys`);
}
