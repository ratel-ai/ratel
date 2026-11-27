import { redirectOld } from "../../../old-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The old page of a case: a case is a row of its dataset now. */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; caseId: string }> },
): Promise<Response> {
  const { projectId, caseId } = await context.params;
  return redirectOld(request, projectId, { kind: "case", caseId });
}
