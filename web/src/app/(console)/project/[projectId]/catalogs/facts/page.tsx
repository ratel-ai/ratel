import { permanentRedirect } from "next/navigation";

/** No teasers (DESIGN.md, Information architecture): an old link lands on the Catalog. */
export default async function FactsCatalogPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  permanentRedirect(`/project/${encodeURIComponent(projectId)}/catalogs`);
}
