import { redirectOld } from "../../old-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The old "New eval" page: the dialog of the Evals page now. */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  return redirectOld(request, (await context.params).projectId, { kind: "new_eval" });
}
