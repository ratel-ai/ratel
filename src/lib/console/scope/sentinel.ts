import { type LastProjectResolverDeps, resolveLastProjectId } from "@/lib/console/scope/landing";

export type RouteSearchParams = Record<string, string | string[] | undefined>;

export async function sentinelDestination(
  cookieValue: string | null | undefined,
  path: string[] | undefined,
  query: RouteSearchParams,
  userId: string,
  deps?: LastProjectResolverDeps,
): Promise<string> {
  const projectId = await resolveLastProjectId(userId, cookieValue, deps);
  if (!projectId) return "/organizations";

  const suffix = path?.map(encodeURIComponent).join("/");
  const pathname = `/project/${projectId}${suffix ? `/${suffix}` : ""}`;
  const search = toSearchParams(query).toString();
  return search ? `${pathname}?${search}` : pathname;
}

function toSearchParams(query: RouteSearchParams): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined) search.append(key, value);
    }
  }
  return search;
}
