import { notFound, permanentRedirect } from "next/navigation";
import { composition } from "@/lib/composition";
import { legacyRouteHref } from "@/lib/console/scope/legacy-route";
import type { RouteSearchParams } from "@/lib/console/scope/sentinel";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

/**
 * `/members`, now the organization's Team page. Owned (ADR-0004): upstream's proxy redirects it;
 * here the route does. Members are the edition's page, so without it the old address stays a 404.
 */
export default async function LegacyMembersPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  if (!(await composition.ui?.())?.MembersPage) notFound();
  const href = await legacyRouteHref("/members", await searchParams, await getConsoleScope());
  if (!href) notFound();
  permanentRedirect(href);
}
