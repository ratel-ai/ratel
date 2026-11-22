import { notFound } from "next/navigation";
import { CatalogHomeV2Page } from "@/components/console/catalog/CatalogPages";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getProjectById } from "@/lib/platform/projects/queries";
import { getSessionContext } from "@/lib/platform/session";

export const metadata = { title: "Catalog" };

export default async function CatalogsPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Catalog">
        The catalog becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  }

  const context = await getSessionContext();
  if (!context) notFound();

  const { projectId } = await params;
  // The project layout already checked the reader may see the project (a member of its organization).
  const project = await getProjectById(projectId);
  if (!project) notFound();
  const { organization } = context;
  return <CatalogHomeV2Page project={project} organization={organization} />;
}
