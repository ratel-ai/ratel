import { permanentRedirect } from "next/navigation";
import { projectRoot } from "@/lib/console/navigation";

/** No teasers (DESIGN.md, Information architecture): an old link lands on Overview. */
export default async function ChatStorePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  permanentRedirect(projectRoot(projectId));
}
