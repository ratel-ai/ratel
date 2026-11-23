import { isDbConfigured } from "@/lib/platform/db/client";
import { getLogger } from "@/lib/platform/logger";
import { getOrganizationById } from "@/lib/platform/organizations";
import { getProjectById } from "@/lib/platform/projects/queries";

/** Readable names for a project on the request log, so dashboards can group by
 * them instead of ids. `project_path` is `<org slug>/<project slug>`: project
 * slugs repeat across organizations ("default"), the pair does not. */
export type ProjectLabels = {
  org_id: string;
  org_slug: string;
  project_path: string;
};

export type LookupProjectLabels = (projectId: string) => Promise<ProjectLabels | null>;

type CacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;
const logger = getLogger("request-log");

/**
 * Caches lookups per project so a busy project costs one query per task every
 * `ttlMs`. Concurrent misses share one query. A failed lookup resolves to null
 * and is not cached: the log line goes out with ids only.
 */
export function cacheProjectLabels(
  lookup: LookupProjectLabels,
  { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now }: CacheOptions = {},
): LookupProjectLabels {
  const entries = new Map<string, { expiresAt: number; labels: Promise<ProjectLabels | null> }>();

  return (projectId) => {
    const cached = entries.get(projectId);
    if (cached && cached.expiresAt > now()) return cached.labels;

    if (entries.size >= maxEntries) entries.clear();
    const labels = lookup(projectId).catch((error: unknown) => {
      entries.delete(projectId);
      logger.warn({ err: error, project_id: projectId }, "request_log_labels_failed");
      return null;
    });
    entries.set(projectId, { expiresAt: now() + ttlMs, labels });
    return labels;
  };
}

/** The project from the core, its organization through the session port: the edition owns it. */
async function queryProjectLabels(projectId: string): Promise<ProjectLabels | null> {
  if (!isDbConfigured()) return null;
  const project = await getProjectById(projectId);
  if (!project) return null;
  const organization = await getOrganizationById(project.organizationId);
  if (!organization) return null;
  return {
    org_id: organization.id,
    org_slug: organization.slug,
    project_path: `${organization.slug}/${project.slug}`,
  };
}

export const lookupProjectLabels: LookupProjectLabels = cacheProjectLabels(queryProjectLabels);
