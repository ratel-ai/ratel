import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { cache } from "react";
import { isApiKeyExpired } from "@/lib/platform/api-keys";
import {
  type ApiKeyExpiredReporter,
  reportApiKeyExpired,
} from "@/lib/platform/api-keys-observability";
import { getDb } from "@/lib/platform/db/client";
import {
  type ApiKey,
  apiKeys,
  type NewApiKey,
  type NewProject,
  type Project,
  projects,
} from "@/lib/platform/projects/schema";

/** Projects and their API keys (owned port of the upstream query hub). */

export type ProjectLookupDb = Pick<ReturnType<typeof getDb>, "select">;
export type ProjectWriteDb = Pick<ReturnType<typeof getDb>, "insert">;
export type ProjectSettingsDb = Pick<ReturnType<typeof getDb>, "update">;
export type ApiKeyDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project id as it arrives from a URL or a cookie: a lowercase uuid, or null. */
export function parseProjectUuid(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

/** Resolve a globally unique project uuid before checking organization access. */
export async function getProjectById(id: string, db?: ProjectLookupDb): Promise<Project | null> {
  const projectId = parseProjectUuid(id);
  if (!projectId) return null;
  return db ? selectProjectById(projectId, db) : getProjectByIdCached(projectId);
}

const getProjectByIdCached = cache((projectId: string) => selectProjectById(projectId, getDb()));

async function selectProjectById(projectId: string, db: ProjectLookupDb): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return row ?? null;
}

export async function createProject(
  input: NewProject,
  db: ProjectWriteDb = getDb(),
): Promise<Project> {
  const [row] = await db.insert(projects).values(input).returning();
  return row;
}

/** Update a project's human-facing name without changing its stable slug. */
export async function updateProjectName(
  projectId: string,
  name: string,
  db: ProjectSettingsDb = getDb(),
): Promise<void> {
  await db.update(projects).set({ name }).where(eq(projects.id, projectId));
}

/** One project by slug within an organization: the authorization check every project action runs. */
export async function getProjectBySlug(
  organizationId: string,
  slug: string,
): Promise<Project | null> {
  const [row] = await getDb()
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.slug, slug)))
    .limit(1);
  return row ?? null;
}

/** An organization's projects, oldest first. */
export async function listProjectsForOrganization(
  organizationId: string,
  db: ProjectLookupDb = getDb(),
): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .orderBy(asc(projects.createdAt));
}

/** Permanently delete a project; its keys and telemetry cascade. */
export async function deleteProject(id: string): Promise<void> {
  await getDb().delete(projects).where(eq(projects.id, id));
}

/* API keys */

/** Keys that have not yet reached their expiry. Null expiry = never expires. */
function unexpired(now: Date) {
  return or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now));
}

export async function createApiKey(input: NewApiKey, db: ApiKeyDb = getDb()): Promise<ApiKey> {
  const [row] = await db.insert(apiKeys).values(input).returning();
  return row;
}

/** Every unrevoked key a project holds, newest first; expired ones stay listed as expired. */
export async function listApiKeysForProject(
  projectId: string,
  db: ApiKeyDb = getDb(),
): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, projectId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
}

/** One of a project's keys, by id: the ownership check before a revoke. */
export async function findApiKeyForProject(
  projectId: string,
  keyId: string,
  db: ApiKeyDb = getDb(),
): Promise<ApiKey | null> {
  if (!UUID.test(keyId)) return null;
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

/** The project's newest usable key, or null; expired and revoked keys are skipped. */
export async function getPrimaryApiKeyForProject(
  projectId: string,
  db: ApiKeyDb = getDb(),
): Promise<ApiKey | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.projectId, projectId), isNull(apiKeys.revokedAt), unexpired(new Date())))
    .orderBy(desc(apiKeys.createdAt))
    .limit(1);
  return row ?? null;
}

export async function revokeApiKey(id: string, db: ApiKeyDb = getDb()): Promise<void> {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
}

/**
 * Look up a usable key by its hash: the auth step every API-key surface shares. Revoked keys
 * are filtered in SQL; expiry is decided here so the rejected key is in hand to report.
 */
export async function findActiveApiKeyByHash(
  hash: string,
  reportExpired: ApiKeyExpiredReporter = reportApiKeyExpired,
  db: ApiKeyDb = getDb(),
): Promise<ApiKey | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (isApiKeyExpired(row)) {
    try {
      await reportExpired(row);
    } catch {
      // Already logged by the reporter; the rejection stands either way.
    }
    return null;
  }
  return row;
}

export async function touchApiKey(id: string): Promise<void> {
  await getDb().update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}
