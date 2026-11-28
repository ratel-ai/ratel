import { evalPage } from "../../evals-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval" };

/** One eval: its definition, how each scorer moved, and its runs. */
export default async function EvalPage({
  params,
}: {
  params: Promise<{ projectId: string; evalId: string }>;
}) {
  const { projectId, evalId } = await params;
  return evalPage(projectId, evalId);
}
