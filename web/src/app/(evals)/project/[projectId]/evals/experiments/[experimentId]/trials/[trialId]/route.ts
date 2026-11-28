import { redirectOld } from "../../../../../old-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The old page of a trial: the trial lives in the run of its eval now. */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; experimentId: string; trialId: string }> },
): Promise<Response> {
  const { projectId, experimentId, trialId } = await context.params;
  return redirectOld(request, projectId, { kind: "run", experimentId, trialId });
}
