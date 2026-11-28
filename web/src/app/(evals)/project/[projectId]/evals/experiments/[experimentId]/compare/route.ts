import { redirectOld } from "../../../../old-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The old comparison page: the runs table of the eval shows each delta against its baseline. */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; experimentId: string }> },
): Promise<Response> {
  const { projectId, experimentId } = await context.params;
  return redirectOld(request, projectId, { kind: "run", experimentId });
}
