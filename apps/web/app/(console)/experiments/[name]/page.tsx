import { notFound, permanentRedirect } from "next/navigation";
import { legacyRouteHref } from "@/lib/console/scope/legacy-route";
import type { RouteSearchParams } from "@/lib/console/scope/sentinel";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

/** `/experiments/<name>`, now the project's calibration. Owned (ADR-0030): upstream's proxy redirects it; here the route does. */
export default async function LegacyExperimentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<RouteSearchParams>;
}) {
  const [{ name }, query, scope] = await Promise.all([params, searchParams, getConsoleScope()]);
  const href = await legacyRouteHref(`/experiments/${encodeURIComponent(name)}`, query, scope);
  if (!href) notFound();
  permanentRedirect(href);
}
