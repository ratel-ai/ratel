import { parseProjectUuid } from "@/lib/console/scope/cookie";

/**
 * Query parameters only the removed Intents and Suggestions tabs read. An old
 * `/explore?tab=intents` link still lands on the improvement index; these are
 * dropped on the way so the address carries nothing that page ignores.
 */
const RETIRED_EXPLORE_PARAMS = ["tab", "intentsPage", "intentsSort", "sstatus"];

export type ResolveProjectId = (projectSlug: string) => Promise<string | null>;
export type ResolveOrganizationSlug = () => Promise<string | null>;
export type LegacyRouteRedirect = {
  destination: string;
  status: 308;
};
type RouteLocation = Pick<URL, "pathname" | "searchParams">;

export function iaV2CandidatePath(pathname: string): boolean {
  return (
    pathname.startsWith("/project/") ||
    scopedProjectPath({ pathname, searchParams: new URLSearchParams() }) !== null ||
    scopedOrganizationPath(pathname) !== null
  );
}

export async function legacyRouteRedirect(
  url: URL,
  resolveProjectId: ResolveProjectId,
  resolveOrganizationSlug?: ResolveOrganizationSlug,
): Promise<LegacyRouteRedirect | null> {
  const destination = await legacyRouteDestination(url, resolveProjectId, resolveOrganizationSlug);
  return destination ? { destination, status: 308 } : null;
}

export async function legacyRouteDestination(
  url: URL,
  resolveProjectId: ResolveProjectId,
  resolveOrganizationSlug?: ResolveOrganizationSlug,
): Promise<string | null> {
  const scopedPath = scopedProjectPath(url);
  if (!scopedPath) {
    const organizationPath = scopedOrganizationPath(url.pathname);
    if (!organizationPath || !resolveOrganizationSlug) return null;
    const organizationSlug = await resolveOrganizationSlug();
    return organizationSlug
      ? withQuery(
          `/org/${encodeURIComponent(organizationSlug)}${organizationPath}`,
          url.searchParams,
        )
      : null;
  }

  const searchParams = new URLSearchParams(url.searchParams);
  const projectSlug = searchParams.get("project");
  const resolved = projectSlug ? await resolveProjectId(projectSlug) : null;
  const projectId = parseProjectUuid(resolved);
  searchParams.delete("project");
  if (scopedPath === "/improvement") {
    for (const key of RETIRED_EXPLORE_PARAMS) searchParams.delete(key);
  }

  return withQuery(
    projectId ? `/project/${projectId}${scopedPath}` : `/project/_${scopedPath}`,
    searchParams,
  );
}

function scopedOrganizationPath(pathname: string): string | null {
  if (pathname === "/members") return "/team";
  if (pathname === "/billing") return "/billing";
  return null;
}

function scopedProjectPath(url: RouteLocation): string | null {
  const { pathname, searchParams } = url;
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    return pathname.replace("/dashboard", "/dashboards");
  }
  if (pathname === "/traces/events") return "/traces/logs";
  if (pathname === "/traces" || pathname.startsWith("/traces/")) {
    return pathname;
  }
  if (pathname === "/explore") {
    const tab = searchParams.get("tab");
    return tab === "intents" || tab === "suggestions" ? "/improvement" : "/catalogs/skills";
  }
  if (pathname === "/experiments" || pathname.startsWith("/experiments/")) {
    return pathname.replace("/experiments", "/calibration");
  }
  if (pathname === "/embeddings") return "/models/embeddings";
  if (pathname === "/settings") return "/settings";
  return null;
}

function withQuery(pathname: string, searchParams: URLSearchParams): string {
  const search = searchParams.toString();
  return search ? `${pathname}?${search}` : pathname;
}
