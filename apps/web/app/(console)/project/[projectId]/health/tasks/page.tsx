import { redirect } from "next/navigation";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks" };

/** The old Agent health › Tasks address: Tasks is a top-level page now, so every visit and its query move there. */
export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  redirect(topLevelTasksHref(projectId, undefined, await searchParams));
}
