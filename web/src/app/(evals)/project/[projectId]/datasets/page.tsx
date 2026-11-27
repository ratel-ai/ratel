import { datasetsListPage } from "./dataset-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Datasets" };

/** The datasets of the project, a filter and the "New dataset" dialog. */
export default async function DatasetsPage({ params }: { params: Promise<{ projectId: string }> }) {
  return datasetsListPage((await params).projectId);
}
