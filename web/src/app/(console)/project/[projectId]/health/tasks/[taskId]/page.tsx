import { redirect } from "next/navigation";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Task" };

/** The old Agent health › Tasks › task address: the task's page is top-level now, so every visit and its query move there. */
export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, taskId } = await params;
  redirect(topLevelTasksHref(projectId, taskId, await searchParams));
}
