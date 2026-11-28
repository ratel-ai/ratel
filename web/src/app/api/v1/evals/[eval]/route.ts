import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyRunsDeps } from "@/lib/views/evals/key-deps";
import { handleEvalByKey } from "@/lib/views/evals/runs-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/[eval]: one eval (name or id) with its runs and a series for each scorer. */
export const GET = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ eval: string }> }) =>
    handleEvalByKey(
      decodeURIComponent((await params).eval),
      keyRunsDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/[eval]"]),
    ),
);
