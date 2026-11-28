import { datasetPage } from "../../evals-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dataset" };

/** One dataset: its rows, or its query and what it reads now. */
export default async function DatasetPage({
  params,
}: {
  params: Promise<{ projectId: string; datasetId: string }>;
}) {
  const { projectId, datasetId } = await params;
  return datasetPage(projectId, datasetId);
}
