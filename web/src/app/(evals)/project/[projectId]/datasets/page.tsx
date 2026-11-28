import { datasetsPage } from "../evals-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Datasets" };

/** The datasets of the project, a filter, and "New dataset". */
export default async function DatasetsPage({ params }: { params: Promise<{ projectId: string }> }) {
  return datasetsPage((await params).projectId);
}
