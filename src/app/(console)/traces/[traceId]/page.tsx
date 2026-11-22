import { notFound, permanentRedirect } from "next/navigation";
import { legacyRouteHref } from "@/lib/console/scope/legacy-route";
import type { RouteSearchParams } from "@/lib/console/scope/sentinel";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

/** `/traces/<traceId>`. Owned (ADR-0030): upstream's proxy redirects it; here the route does. */
export default async function LegacyTraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ traceId: string }>;
  searchParams: Promise<RouteSearchParams>;
}) {
  const [{ traceId }, query, scope] = await Promise.all([params, searchParams, getConsoleScope()]);
  const href = await legacyRouteHref(`/traces/${encodeURIComponent(traceId)}`, query, scope);
  if (!href) notFound();
  permanentRedirect(href);
}
