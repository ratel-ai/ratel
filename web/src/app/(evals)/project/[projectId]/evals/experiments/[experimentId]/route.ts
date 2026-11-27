import { redirectOld } from "../../../old-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The old page of a run: the run lives in its eval now. */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; experimentId: string }> },
): Promise<Response> {
  const { projectId, experimentId } = await context.params;
  return redirectOld(request, projectId, { kind: "run", experimentId });
}
