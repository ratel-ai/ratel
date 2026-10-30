import { notFound } from "next/navigation";
import { ToolsV2Page } from "@/components/console/catalog/CatalogPages";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getProjectById } from "@/lib/platform/projects/queries";

export const metadata = { title: "Tools" };

export default async function ToolsCatalogPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Tools">Tools appear once setup finishes.</DatabaseUnavailable>
    );
  }
  const { projectId } = await params;
  // The project layout already guarded the id against the session organization.
  const project = await getProjectById(projectId);
  if (!project) notFound();
  return <ToolsV2Page project={project} />;
}
