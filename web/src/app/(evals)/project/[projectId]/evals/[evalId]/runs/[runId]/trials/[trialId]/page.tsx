import { trialPage } from "../../../../../../evals-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval trial" };

/** One trial next to the baseline trial: output, tools, scorer reasons, trace and session replay. */
export default async function TrialPage({
  params,
}: {
  params: Promise<{ projectId: string; evalId: string; runId: string; trialId: string }>;
}) {
  const { projectId, evalId, runId, trialId } = await params;
  return trialPage(projectId, evalId, runId, trialId);
}
