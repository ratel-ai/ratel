import { legacyRouteDestination } from "./legacy-redirects";
import { movedPageDestination } from "./moved-pages";
import type { RouteSearchParams } from "./sentinel";

/**
 * Where an old top-level address lands (`/traces`, `/explore`, `/settings`, `/experiments`, with
 * their sub-paths). Upstream's proxy answers these before any page runs, with the legacy rules
 * and then the moved-pages rules, in one hop; this edition has no proxy (ADR-0029), so the
 * routes under `app/(console)` call this and redirect. `?project=<slug>` is resolved in the
 * session organization's projects; without one the destination keeps the `/project/_` sentinel,
 * which resolves the last or first project in a second hop.
 */

export interface LegacyRouteScope {
  projects: readonly { id: string; slug: string }[];
  organizationSlug: string | undefined;
}

const BASE = "http://console.local";

export async function legacyRouteHref(
  pathname: string,
  query: RouteSearchParams,
  scope: LegacyRouteScope | null,
): Promise<string | null> {
  const url = new URL(pathname, BASE);
  for (const [key, raw] of Object.entries(query)) {
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value !== undefined) url.searchParams.append(key, value);
    }
  }
  const destination = await legacyRouteDestination(
    url,
    async (slug) => scope?.projects.find((project) => project.slug === slug)?.id ?? null,
    async () => scope?.organizationSlug ?? null,
  );
  if (!destination) return null;
  return movedPageDestination(new URL(destination, BASE)) ?? destination;
}
