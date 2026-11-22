import { notFound, permanentRedirect } from "next/navigation";
import { legacyRouteHref } from "@/lib/console/scope/legacy-route";
import type { RouteSearchParams } from "@/lib/console/scope/sentinel";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

/**
 * `/explore`: the skills catalog, or Fixes for the retired Intents and Suggestions tabs.
 * Owned (ADR-0030): upstream's proxy redirects it; here the route does.
 */
export default async function LegacyExplorePage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const href = await legacyRouteHref("/explore", await searchParams, await getConsoleScope());
  if (!href) notFound();
  permanentRedirect(href);
}
