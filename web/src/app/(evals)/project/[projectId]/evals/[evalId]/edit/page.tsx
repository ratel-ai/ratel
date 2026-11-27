import { editEvalPage } from "../eval-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit eval" };

/** "Edit" of an eval: a save with other content adds a version. */
export default async function EditEvalPage({
  params,
}: {
  params: Promise<{ projectId: string; evalId: string }>;
}) {
  const { projectId, evalId } = await params;
  return editEvalPage(projectId, evalId);
}
