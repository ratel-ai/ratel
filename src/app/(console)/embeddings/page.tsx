import { notFound, permanentRedirect } from "next/navigation";
import { composition } from "@/lib/composition";
import { legacyRouteHref } from "@/lib/console/scope/legacy-route";
import type { RouteSearchParams } from "@/lib/console/scope/sentinel";
import { getConsoleScope } from "@/lib/console/shell-data";

export const dynamic = "force-dynamic";

/**
 * `/embeddings`, now the project's. Owned (ADR-0004): upstream's proxy redirects it; here the
 * route does. The embeddings page is the edition's, so without it the old address stays a 404.
 */
export default async function LegacyEmbeddingsPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const pages = (await composition.ui?.())?.ProjectPages;
  if (!pages || !Object.hasOwn(pages, "embeddings")) notFound();
  const href = await legacyRouteHref("/embeddings", await searchParams, await getConsoleScope());
  if (!href) notFound();
  permanentRedirect(href);
}
