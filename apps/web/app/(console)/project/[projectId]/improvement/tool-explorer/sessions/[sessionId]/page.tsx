import { permanentRedirect } from "next/navigation";
import { taskSessionHref } from "@/lib/views/tasks/paths";
import { parseMarkedTools } from "@/lib/views/tasks/session";

/** Tool craft's session drill-down moved under Tasks; old links keep the tools they marked. */
export default async function LegacyToolCraftSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, sessionId }, query] = await Promise.all([params, searchParams]);
  permanentRedirect(
    taskSessionHref(projectId, sessionId, { tools: parseMarkedTools(query.tools) }),
  );
}
