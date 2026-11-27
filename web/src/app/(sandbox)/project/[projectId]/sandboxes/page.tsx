import { sandboxListPage } from "./sandbox-pages";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sandboxes" };

/** The sandboxes of the project, the "New sandbox" dialog and the project secrets. */
export default async function SandboxesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  return sandboxListPage((await params).projectId);
}
