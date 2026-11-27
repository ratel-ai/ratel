import { runPage } from "../../../../evals-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval run" };

/** One run of an eval: its rows, the output and each scorer, the variants side by side. */
export default async function RunPage({
  params,
}: {
  params: Promise<{ projectId: string; evalId: string; runId: string }>;
}) {
  const { projectId, evalId, runId } = await params;
  return runPage(projectId, evalId, runId);
}
