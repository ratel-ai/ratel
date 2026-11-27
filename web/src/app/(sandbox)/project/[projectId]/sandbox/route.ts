import { sandboxesEnabledForProject } from "@/lib/views/sandboxes/gate";
import { sandboxesHref } from "@/lib/views/sandboxes/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The old address of the sandbox page. A route, not a page: a page streams the console shell
 * first, so its redirect would answer 200. With the flag off it answers 404 like the pages.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  if (!(await sandboxesEnabledForProject(projectId))) {
    return new Response("Not found", { status: 404 });
  }
  return Response.redirect(new URL(sandboxesHref(projectId), request.url), 307);
}
